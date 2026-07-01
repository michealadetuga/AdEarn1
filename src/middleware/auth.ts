import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/http.js";
import { supabase } from "../lib/supabase.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      throw new ApiError(401, "Missing bearer token");
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new ApiError(401, "Invalid or expired token");
    }

    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("is_admin,is_banned,email")
      .eq("id", data.user.id)
      .single();

    if (profileError || !profile) {
      throw new ApiError(401, "User profile not found");
    }

    if (profile.is_banned) {
      throw new ApiError(403, "Account is locked. Contact support@adearn.com.ng");
    }

    req.auth = {
      userId: data.user.id,
      email: profile.email ?? data.user.email ?? undefined,
      isAdmin: Boolean(profile.is_admin),
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.isAdmin) {
    next(new ApiError(403, "Admin access required"));
    return;
  }

  next();
}

export function readDeviceFingerprint(req: Request, _res: Response, next: NextFunction) {
  const fingerprint = req.header("X-Device-Fingerprint");
  if (fingerprint && /^[a-zA-Z0-9:_-]{8,128}$/.test(fingerprint)) {
    req.deviceFingerprint = fingerprint;
  }
  next();
}
