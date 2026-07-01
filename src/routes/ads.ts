import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ApiError, assertString, ok } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";
import { getPlatformSettings } from "../lib/settings.js";

const router = Router();
const POINTS_PER_NAIRA = 10;

export const completeAdLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

function clientIp(req: Parameters<Parameters<typeof router.get>[1]>[0]) {
  return (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "unknown").trim();
}

router.get("/", requireAuth, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("ads")
      .select("id,ad_network,ad_unit_id,ad_type,points_reward,duration_seconds,is_active")
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    if (error) throw error;
    ok(res, { ads: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get("/progress", requireAuth, async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    const today = await supabase.rpc("get_today_view_count", { target_user_id: req.auth?.userId });
    if (today.error) throw today.error;

    const { data: lastView, error: lastError } = await supabase
      .from("ad_views")
      .select("completed_at")
      .eq("user_id", req.auth?.userId)
      .eq("completed", true)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;

    const elapsed = lastView?.completed_at ? Math.floor((Date.now() - new Date(lastView.completed_at).getTime()) / 1000) : 999;
    ok(res, {
      today_count: today.data ?? 0,
      daily_limit: settings.daily_ad_limit,
      cooldown_seconds_remaining: Math.max(0, settings.ad_cooldown_seconds - elapsed),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/view/start", requireAuth, async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    const adId = assertString(req.body.ad_id, "ad_id");
    const ip = clientIp(req);

    const today = await supabase.rpc("get_today_view_count", { target_user_id: req.auth?.userId });
    if (today.error) throw today.error;
    if ((today.data ?? 0) >= settings.daily_ad_limit) throw new ApiError(403, "Daily ad limit reached");

    const { count: ipCount, error: ipError } = await supabase
      .from("ad_views")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", ip)
      .eq("completed", true)
      .gte("completed_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
    if (ipError) throw ipError;
    if ((ipCount ?? 0) >= settings.daily_ip_ad_limit) {
      await supabase.from("fraud_flags").insert({ user_id: req.auth?.userId, flag_type: "ip_limit_exceeded", details: { ip } });
      throw new ApiError(403, "Daily IP ad limit reached");
    }

    const { data: lastView, error: lastError } = await supabase
      .from("ad_views")
      .select("completed_at")
      .eq("user_id", req.auth?.userId)
      .eq("completed", true)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;
    const elapsed = lastView?.completed_at ? Math.floor((Date.now() - new Date(lastView.completed_at).getTime()) / 1000) : 999;
    if (elapsed < settings.ad_cooldown_seconds) {
      throw new ApiError(403, "Ad cooldown is still active", { seconds_remaining: settings.ad_cooldown_seconds - elapsed });
    }

    const { data: ad, error: adError } = await supabase
      .from("ads")
      .select("id,ad_network,ad_unit_id,duration_seconds,points_reward,is_active")
      .eq("id", adId)
      .eq("is_active", true)
      .single();
    if (adError || !ad) throw new ApiError(404, "Active ad not found");

    const { data: view, error: viewError } = await supabase
      .from("ad_views")
      .insert({ user_id: req.auth?.userId, ad_id: ad.id, ip_address: ip, device_fingerprint: req.deviceFingerprint })
      .select("id")
      .single();
    if (viewError) throw viewError;

    ok(res, { view_id: view.id, ad_unit_id: ad.ad_unit_id, ad_network: ad.ad_network, duration_seconds: ad.duration_seconds, points_reward: ad.points_reward }, 201);
  } catch (error) {
    next(error);
  }
});

router.post("/view/complete", requireAuth, completeAdLimiter, async (req, res, next) => {
  try {
    const viewId = assertString(req.body.view_id, "view_id");
    const { data: view, error: viewError } = await supabase
      .from("ad_views")
      .select("id,user_id,started_at,completed,ad_id,ads(duration_seconds,points_reward)")
      .eq("id", viewId)
      .eq("user_id", req.auth?.userId)
      .single();
    if (viewError || !view) throw new ApiError(404, "Ad view not found");
    if (view.completed) throw new ApiError(409, "Points already claimed for this ad");

    const ad = Array.isArray(view.ads) ? view.ads[0] : view.ads;
    const elapsed = Math.floor((Date.now() - new Date(view.started_at).getTime()) / 1000);
    const required = Math.ceil(Number(ad.duration_seconds) * 0.85);
    if (elapsed < required) {
      await supabase.from("fraud_flags").insert({ user_id: req.auth?.userId, flag_type: "fast_completion", details: { view_id: viewId, elapsed, required } });
      throw new ApiError(403, "Too fast. Watch at least 85% of the ad before claiming.");
    }

    if (req.deviceFingerprint) {
      const { data: usersForFingerprint } = await supabase
        .from("ad_views")
        .select("user_id")
        .eq("device_fingerprint", req.deviceFingerprint);
      const uniqueUsers = new Set((usersForFingerprint ?? []).map((row) => row.user_id));
      uniqueUsers.add(req.auth?.userId ?? "");
      if (uniqueUsers.size >= 3) {
        await Promise.all([...uniqueUsers].filter(Boolean).map((userId) => supabase.from("fraud_flags").insert({ user_id: userId, flag_type: "fingerprint_collision", details: { fingerprint: req.deviceFingerprint, account_count: uniqueUsers.size } })));
      }
    }

    const points = Number(ad.points_reward);
    const { error: updateError } = await supabase
      .from("ad_views")
      .update({ completed: true, completed_at: new Date().toISOString(), watch_duration: elapsed, points_earned: points, device_fingerprint: req.deviceFingerprint })
      .eq("id", viewId)
      .eq("completed", false);
    if (updateError) throw updateError;

    const { error: pointsError } = await supabase.rpc("add_user_points", { target_user_id: req.auth?.userId, points_delta: points });
    if (pointsError) throw pointsError;

    const { count: completedCount, error: countError } = await supabase
      .from("ad_views")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.auth?.userId)
      .eq("completed", true);
    if (countError) throw countError;

    if ((completedCount ?? 0) === 1) {
      const { data: referral } = await supabase
        .from("referrals")
        .select("id,referrer_id,firstwatch_bonus_paid,total_bonus_points")
        .eq("referred_id", req.auth?.userId)
        .maybeSingle();
      if (referral && !referral.firstwatch_bonus_paid) {
        await supabase.rpc("add_user_points", { target_user_id: referral.referrer_id, points_delta: 200 });
        await supabase.from("referrals").update({ firstwatch_bonus_paid: true, total_bonus_points: Number(referral.total_bonus_points ?? 0) + 200 }).eq("id", referral.id);
      }
    }

    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("balance_points")
      .eq("id", req.auth?.userId)
      .single();
    if (profileError) throw profileError;

    ok(res, { points_earned: points, new_balance: profile.balance_points, naira_value: profile.balance_points / POINTS_PER_NAIRA, message: `+${points} Points Earned!` });
  } catch (error) {
    next(error);
  }
});

export default router;
