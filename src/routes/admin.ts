import { Router } from "express";
import { ApiError, assertString, ok } from "../utils/http.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";
import { sendMail, templates } from "../utils/mailer.js";
import { getPlatformSettings, updatePlatformSettings } from "../lib/settings.js";
import type { PlatformSettings } from "../../../shared/constants/platformSettings.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/overview", async (_req, res, next) => {
  try {
    const [users, activeToday, pending, paid, flags] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }),
      supabase.from("ad_views").select("user_id", { count: "exact", head: true }).gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      supabase.from("withdrawals").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("withdrawals").select("amount_naira").eq("status", "paid"),
      supabase.from("fraud_flags").select("id", { count: "exact", head: true }).eq("resolved", false),
    ]);
    const totalPaid = (paid.data ?? []).reduce((sum, row) => sum + Number(row.amount_naira ?? 0), 0);
    ok(res, { total_users: users.count ?? 0, active_today: activeToday.count ?? 0, pending_withdrawals: pending.count ?? 0, total_paid_out: totalPaid, unresolved_fraud_flags: flags.count ?? 0 });
  } catch (error) {
    next(error);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim();
    let builder = supabase.from("users").select("id,full_name,email,balance_points,total_earned,total_withdrawn,is_banned,is_admin,created_at").order("created_at", { ascending: false }).limit(100);
    if (query) builder = builder.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`);
    const { data, error } = await builder;
    if (error) throw error;
    ok(res, { users: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.patch("/users/:id/ban", async (req, res, next) => {
  try {
    const banned = Boolean(req.body.is_banned);
    const { error } = await supabase.from("users").update({ is_banned: banned }).eq("id", req.params.id);
    if (error) throw error;
    ok(res, { message: banned ? "User banned" : "User unbanned" });
  } catch (error) {
    next(error);
  }
});

router.get("/withdrawals", async (req, res, next) => {
  try {
    const status = String(req.query.status ?? "pending");
    let builder = supabase.from("withdrawals").select("*,users(full_name,email)").order("created_at", { ascending: false }).limit(100);
    if (["pending", "paid", "rejected"].includes(status)) builder = builder.eq("status", status);
    const { data, error } = await builder;
    if (error) throw error;
    ok(res, { withdrawals: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.patch("/withdrawals/:id/pay", async (req, res, next) => {
  try {
    const { data: withdrawal, error: fetchError } = await supabase.from("withdrawals").select("*,users(full_name,email)").eq("id", req.params.id).single();
    if (fetchError || !withdrawal) throw fetchError ?? new ApiError(404, "Withdrawal not found");
    const { error } = await supabase.from("withdrawals").update({ status: "paid", paystack_transfer_code: req.body.paystack_transfer_code ?? null }).eq("id", req.params.id);
    if (error) throw error;
    const user = Array.isArray(withdrawal.users) ? withdrawal.users[0] : withdrawal.users;
    await sendMail(user?.email, templates.withdrawalPaid(user?.full_name ?? "there", Number(withdrawal.amount_naira), withdrawal.bank_name));
    ok(res, { message: "Withdrawal marked as paid" });
  } catch (error) {
    next(error);
  }
});

router.patch("/withdrawals/:id/reject", async (req, res, next) => {
  try {
    const reason = assertString(req.body.reason, "reason");
    const { data: withdrawal, error: fetchError } = await supabase.from("withdrawals").select("*,users(full_name,email)").eq("id", req.params.id).single();
    if (fetchError || !withdrawal) throw fetchError ?? new ApiError(404, "Withdrawal not found");
    if (withdrawal.status !== "pending") throw new ApiError(409, "Only pending withdrawals can be rejected");
    await supabase.rpc("add_user_points", { target_user_id: withdrawal.user_id, points_delta: withdrawal.points_spent });
    const { error } = await supabase.from("withdrawals").update({ status: "rejected", rejection_reason: reason }).eq("id", req.params.id);
    if (error) throw error;
    const user = Array.isArray(withdrawal.users) ? withdrawal.users[0] : withdrawal.users;
    await sendMail(user?.email, templates.withdrawalRejected(user?.full_name ?? "there", Number(withdrawal.amount_naira), reason));
    ok(res, { message: "Withdrawal rejected and points refunded" });
  } catch (error) {
    next(error);
  }
});

router.get("/ads", async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from("ads").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    ok(res, { ads: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.post("/ads", async (req, res, next) => {
  try {
    const payload = {
      ad_network: assertString(req.body.ad_network, "ad_network"),
      ad_unit_id: assertString(req.body.ad_unit_id, "ad_unit_id"),
      ad_type: assertString(req.body.ad_type, "ad_type"),
      points_reward: Number(req.body.points_reward ?? 50),
      duration_seconds: Number(req.body.duration_seconds ?? 30),
    };
    const { data, error } = await supabase.from("ads").insert(payload).select("*").single();
    if (error) throw error;
    ok(res, { ad: data }, 201);
  } catch (error) {
    next(error);
  }
});

router.patch("/ads/:id", async (req, res, next) => {
  try {
    const { error } = await supabase.from("ads").update(req.body).eq("id", req.params.id);
    if (error) throw error;
    ok(res, { message: "Ad updated" });
  } catch (error) {
    next(error);
  }
});

router.get("/fraud-flags", async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from("fraud_flags").select("*,users(full_name,email)").eq("resolved", false).order("created_at", { ascending: false });
    if (error) throw error;
    ok(res, { flags: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.patch("/fraud-flags/:id/resolve", async (req, res, next) => {
  try {
    const { error } = await supabase.from("fraud_flags").update({ resolved: true }).eq("id", req.params.id);
    if (error) throw error;
    ok(res, { message: "Fraud flag resolved" });
  } catch (error) {
    next(error);
  }
});

router.get("/settings", async (_req, res, next) => {
  try {
    const settings = await getPlatformSettings(true);
    ok(res, { settings });
  } catch (error) {
    next(error);
  }
});

function clampSetting(key: keyof PlatformSettings, value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new ApiError(400, `Invalid value for ${key}`);

  const ranges: Record<keyof PlatformSettings, [number, number]> = {
    daily_ad_limit: [1, 500],
    daily_ip_ad_limit: [1, 500],
    ad_cooldown_seconds: [0, 3600],
    daily_social_task_limit: [0, 100],
  };

  const [min, max] = ranges[key];
  if (num < min || num > max) throw new ApiError(400, `${key} must be between ${min} and ${max}`);
  return Math.round(num);
}

router.patch("/settings", async (req, res, next) => {
  try {
    const allowedKeys: (keyof PlatformSettings)[] = [
      "daily_ad_limit",
      "daily_ip_ad_limit",
      "ad_cooldown_seconds",
      "daily_social_task_limit",
    ];

    const updates: Partial<PlatformSettings> = {};
    for (const key of allowedKeys) {
      if (req.body[key] !== undefined) {
        updates[key] = clampSetting(key, req.body[key]);
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "No valid settings provided");
    }

    const settings = await updatePlatformSettings(updates, req.auth!.userId);
    ok(res, { settings, message: "Task limits updated" });
  } catch (error) {
    next(error);
  }
});

export default router;
