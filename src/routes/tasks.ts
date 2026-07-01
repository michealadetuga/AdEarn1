import { Router } from "express";
import { ApiError, assertString, ok } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";
import { getPlatformSettings } from "../lib/settings.js";
import { SOCIAL_TASK_REWARDS } from "../../../shared/constants/platformSettings.js";

const router = Router();

router.get("/progress", requireAuth, async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    const today = await supabase.rpc("get_today_social_task_count", { target_user_id: req.auth?.userId });
    if (today.error) throw today.error;

    const { data: completions, error: completionError } = await supabase
      .from("social_task_completions")
      .select("task_id")
      .eq("user_id", req.auth?.userId);
    if (completionError) throw completionError;

    ok(res, {
      today_count: today.data ?? 0,
      daily_limit: settings.daily_social_task_limit,
      completed_task_ids: (completions ?? []).map((row) => row.task_id),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/complete", requireAuth, async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    const taskId = assertString(req.body.task_id, "task_id");
    const proof = String(req.body.proof ?? "").trim();

    const reward = SOCIAL_TASK_REWARDS[taskId];
    if (!reward) throw new ApiError(404, "Unknown social task");

    if (!proof) throw new ApiError(400, "Proof is required to complete this task");

    const { data: existing, error: existingError } = await supabase
      .from("social_task_completions")
      .select("id")
      .eq("user_id", req.auth?.userId)
      .eq("task_id", taskId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) throw new ApiError(409, "Task already completed");

    const today = await supabase.rpc("get_today_social_task_count", { target_user_id: req.auth?.userId });
    if (today.error) throw today.error;
    if ((today.data ?? 0) >= settings.daily_social_task_limit) {
      throw new ApiError(403, "Daily social task limit reached");
    }

    const { error: insertError } = await supabase.from("social_task_completions").insert({
      user_id: req.auth?.userId,
      task_id: taskId,
      points_earned: reward,
      proof,
    });
    if (insertError) throw insertError;

    const { error: pointsError } = await supabase.rpc("add_user_points", {
      target_user_id: req.auth?.userId,
      points_delta: reward,
    });
    if (pointsError) throw pointsError;

    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("balance_points")
      .eq("id", req.auth?.userId)
      .single();
    if (profileError) throw profileError;

    ok(res, {
      points_earned: reward,
      new_balance: profile.balance_points,
      message: `+${reward} Points Earned!`,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
