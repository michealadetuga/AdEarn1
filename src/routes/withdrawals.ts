import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ApiError, assertString, ok } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";
import { sendMail, templates } from "../utils/mailer.js";

const router = Router();
const POINTS_PER_NAIRA = 10;

export const withdrawalLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 3,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/verify-account", requireAuth, async (req, res, next) => {
  try {
    const accountNumber = assertString(req.query.account_number, "account_number");
    const bankCode = assertString(req.query.bank_code, "bank_code");
    if (!/^\d{10}$/.test(accountNumber)) throw new ApiError(400, "Account number must be 10 digits");
    if (!process.env.PAYSTACK_SECRET_KEY) throw new ApiError(503, "Paystack is not configured");

    const response = await fetch(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const body = await response.json() as { status?: boolean; message?: string; data?: { account_name?: string; account_number?: string } };
    if (!response.ok || !body.status || !body.data?.account_name) {
      throw new ApiError(400, body.message ?? "Could not resolve bank account");
    }

    ok(res, { account_name: body.data.account_name, account_number: body.data.account_number });
  } catch (error) {
    next(error);
  }
});

router.post("/request", requireAuth, withdrawalLimiter, async (req, res, next) => {
  try {
    const amountNaira = Number(req.body.amount_naira);
    const bankName = assertString(req.body.bank_name, "bank_name");
    const bankCode = assertString(req.body.bank_code, "bank_code");
    const accountNumber = assertString(req.body.account_number, "account_number");
    const accountName = assertString(req.body.account_name, "account_name");

    if (!Number.isInteger(amountNaira) || amountNaira < 1000) throw new ApiError(400, "Minimum withdrawal is NGN 1,000");
    if (!/^\d{10}$/.test(accountNumber)) throw new ApiError(400, "Account number must be 10 digits");

    const pointsNeeded = amountNaira * POINTS_PER_NAIRA;
    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("full_name,email,balance_points,created_at")
      .eq("id", req.auth?.userId)
      .single();
    if (profileError || !profile) throw profileError ?? new ApiError(404, "Profile not found");
    if (Number(profile.balance_points) < pointsNeeded) throw new ApiError(400, "Insufficient points balance");

    const accountAgeDays = (Date.now() - new Date(profile.created_at).getTime()) / 86400000;
    if (accountAgeDays < 7 && amountNaira >= 10000) {
      await supabase.from("fraud_flags").insert({ user_id: req.auth?.userId, flag_type: "suspicious_withdrawal", details: { amount_naira: amountNaira, account_age_days: accountAgeDays } });
    }

    const { data: result, error } = await supabase.rpc("request_withdrawal", {
      target_user_id: req.auth?.userId,
      amount: amountNaira,
      points_cost: pointsNeeded,
      bank: bankName,
      bank_code_value: bankCode,
      acct_number: accountNumber,
      acct_name: accountName,
    });
    if (error) throw error;

    await sendMail(profile.email, templates.withdrawalRequested(profile.full_name, amountNaira, bankName, accountNumber));
    ok(res, { withdrawal_id: result, new_balance: Number(profile.balance_points) - pointsNeeded, message: "Withdrawal request submitted" }, 201);
  } catch (error) {
    next(error);
  }
});

router.get("/history", requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const from = (page - 1) * 10;
    const to = from + 9;
    const { data, error, count } = await supabase
      .from("withdrawals")
      .select("*", { count: "exact" })
      .eq("user_id", req.auth?.userId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    ok(res, { withdrawals: data ?? [], count: count ?? 0, page });
  } catch (error) {
    next(error);
  }
});

export default router;
