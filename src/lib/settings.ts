import { DEFAULT_PLATFORM_SETTINGS, type PlatformSettings } from "../../../shared/constants/platformSettings.js";
import { supabase } from "./supabase.js";

let cached: PlatformSettings | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function normalize(row: Record<string, unknown>): PlatformSettings {
  return {
    daily_ad_limit: Number(row.daily_ad_limit ?? DEFAULT_PLATFORM_SETTINGS.daily_ad_limit),
    daily_ip_ad_limit: Number(row.daily_ip_ad_limit ?? DEFAULT_PLATFORM_SETTINGS.daily_ip_ad_limit),
    ad_cooldown_seconds: Number(row.ad_cooldown_seconds ?? DEFAULT_PLATFORM_SETTINGS.ad_cooldown_seconds),
    daily_social_task_limit: Number(row.daily_social_task_limit ?? DEFAULT_PLATFORM_SETTINGS.daily_social_task_limit),
  };
}

export async function getPlatformSettings(force = false): Promise<PlatformSettings> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return cached;

  const { data, error } = await supabase
    .from("platform_settings")
    .select("daily_ad_limit,daily_ip_ad_limit,ad_cooldown_seconds,daily_social_task_limit")
    .eq("id", 1)
    .maybeSingle();

  if (error || !data) {
    cached = DEFAULT_PLATFORM_SETTINGS;
  } else {
    cached = normalize(data);
  }

  cachedAt = now;
  return cached;
}

export function clearSettingsCache() {
  cached = null;
  cachedAt = 0;
}

export async function updatePlatformSettings(
  updates: Partial<PlatformSettings>,
  adminUserId: string
): Promise<PlatformSettings> {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
    updated_by: adminUserId,
  };

  const { data, error } = await supabase
    .from("platform_settings")
    .update(payload)
    .eq("id", 1)
    .select("daily_ad_limit,daily_ip_ad_limit,ad_cooldown_seconds,daily_social_task_limit")
    .single();

  if (error) throw error;
  clearSettingsCache();
  return normalize(data);
}
