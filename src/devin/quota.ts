// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import { normalizeSessionToken, DEVIN_HOST } from "./protocol.ts";

const QUOTA_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

type StatusPayload = Record<string, unknown>;

export type DevinQuota = {
	plan: string;
	dailyRemaining?: number;
	weeklyRemaining?: number;
	dailyReset?: number;
	weeklyReset?: number;
	hideDaily: boolean;
	hideWeekly: boolean;
	overageMicros: number;
};

export async function fetchDevinQuota(apiKey: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<DevinQuota> {
	const response = await fetchImpl(`${DEVIN_HOST}${QUOTA_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json", "connect-protocol-version": "1" },
		body: JSON.stringify({ metadata: {
			apiKey: normalizeSessionToken(apiKey), ideName: "devin", ideVersion: "1.108.2",
			extensionName: "devin", extensionVersion: "1.108.2", locale: "en",
		} }),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("Devin quota request failed");
	return parseDevinQuota(await response.json());
}

export function formatDevinQuota(quota: DevinQuota, formatReset: (epoch: number) => string = formatResetTime): string {
	const lines = [`Devin ${quota.plan}`];
	if (!quota.hideDaily && quota.dailyRemaining !== undefined) lines.push(`Daily: ${used(quota.dailyRemaining)}% used${quota.dailyReset ? ` — resets ${formatReset(quota.dailyReset)}` : ""}`);
	if (!quota.hideWeekly && quota.weeklyRemaining !== undefined) lines.push(`Weekly: ${used(quota.weeklyRemaining)}% used${quota.weeklyReset ? ` — resets ${formatReset(quota.weeklyReset)}` : ""}`);
	lines.push(`Extra balance: $${(quota.overageMicros / 1_000_000).toFixed(2)}`);
	return lines.join("\n");
}

function parseDevinQuota(payload: unknown): DevinQuota {
	if (!record(payload)) throw new Error("Invalid Devin quota response");
	const userStatus = value(payload, "userStatus", "user_status");
	const planInfo = value(payload, "planInfo", "plan_info");
	const planStatus = value(userStatus, "planStatus", "plan_status");
	const plan = string(value(planInfo, "planName", "plan_name")) || string(value(value(planStatus, "planInfo", "plan_info"), "planName", "plan_name"));
	if (!plan) throw new Error("Invalid Devin quota response");
	return {
		plan,
		dailyRemaining: percentage(value(planStatus, "dailyQuotaRemainingPercent", "daily_quota_remaining_percent")),
		weeklyRemaining: percentage(value(planStatus, "weeklyQuotaRemainingPercent", "weekly_quota_remaining_percent")),
		dailyReset: integer(value(planStatus, "dailyQuotaResetAtUnix", "daily_quota_reset_at_unix")),
		weeklyReset: integer(value(planStatus, "weeklyQuotaResetAtUnix", "weekly_quota_reset_at_unix")),
		hideDaily: Boolean(value(planInfo, "hideDailyQuota", "hide_daily_quota")),
		hideWeekly: Boolean(value(planInfo, "hideWeeklyQuota", "hide_weekly_quota")),
		overageMicros: integer(value(planStatus, "overageBalanceMicros", "overage_balance_micros")) ?? 0,
	};
}

function record(value: unknown): value is StatusPayload { return typeof value === "object" && value !== null; }
function value(payload: unknown, camel: string, snake: string): unknown { return record(payload) ? payload[camel] ?? payload[snake] : undefined; }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function integer(value: unknown): number | undefined { const result = typeof value === "string" || typeof value === "number" ? Number(value) : NaN; return Number.isFinite(result) ? result : undefined; }
function percentage(value: unknown): number | undefined { const result = integer(value); return result !== undefined && result >= 0 && result <= 100 ? result : undefined; }
function used(remaining: number): number { return Math.max(0, Math.min(100, 100 - remaining)); }
export function formatDevinResetTime(epoch: number, locale: string | undefined = undefined): string {
	return new Date(epoch * 1000).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatResetTime(epoch: number): string { return formatDevinResetTime(epoch); }
