import { Router } from "express";
import rateLimit from "express-rate-limit";
import { assertEmail, assertString, ok, ApiError } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";
import { sendMail, templates } from "../utils/mailer.js";

const router = Router();

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/register", registerLimiter, requireAuth, async (req, res, next) => {
  try {
    const fullName = assertString(req.body.full_name, "full_name");
    const email = assertEmail(req.auth?.email ?? req.body.email);
    const referralCode = typeof req.body.referral_code === "string" ? req.body.referral_code.trim().toUpperCase() : "";

    let referrerId: string | null = null;
    if (referralCode) {
      if (!/^[A-Z0-9]{8}$/.test(referralCode)) {
        throw new ApiError(400, "Referral code must be 8 alphanumeric characters");
      }

      const { data: referrer, error: referrerError } = await supabase
        .from("users")
        .select("id")
        .eq("referral_code", referralCode)
        .maybeSingle();

      if (referrerError) throw referrerError;
      if (!referrer) throw new ApiError(400, "Referral code was not found");
      if (referrer.id === req.auth?.userId) throw new ApiError(400, "You cannot refer yourself");
      referrerId = referrer.id;
    }

    const generated = await supabase.rpc("generate_referral_code");
    if (generated.error || !generated.data) throw generated.error ?? new ApiError(500, "Could not generate referral code");

    const { data: profile, error: upsertError } = await supabase
      .from("users")
      .upsert({
        id: req.auth?.userId,
        full_name: fullName,
        email,
        referral_code: generated.data,
        referred_by: referrerId,
        is_verified: true,
      }, { onConflict: "id" })
      .select("*")
      .single();

    if (upsertError) throw upsertError;

    if (referrerId) {
      const { error: referralError } = await supabase.from("referrals").insert({
        referrer_id: referrerId,
        referred_id: req.auth?.userId,
        signup_bonus_paid: true,
        total_bonus_points: 500,
      });
      if (referralError) throw referralError;

      const { error: bonusError } = await supabase.rpc("add_user_points", {
        target_user_id: referrerId,
        points_delta: 500,
      });
      if (bonusError) throw bonusError;
    }

    await sendMail(email, templates.welcome(fullName, profile.referral_code));
    ok(res, { profile }, 201);
  } catch (error) {
    next(error);
  }
});

export default router;

