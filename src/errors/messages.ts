// ── Engine error messages (i18n) ─────────────────────────────────

import type { MessageCatalog } from "../types/config";
import type { ErrorCode } from "./codes";

export const MESSAGES_EN: Readonly<Record<ErrorCode, string>> = {
  HTTP_ERROR: "The server returned an error.",
  NETWORK_ERROR: "Could not reach the server.",
  TIMEOUT: "The server took too long to respond.",
  ABORTED: "Request aborted.",
  PARSE_ERROR: "The server sent an invalid response.",
  REQUEST_VALIDATION: "Validation error.",
  RESPONSE_VALIDATION: "Response validation error.",
  REQUEST_INVALID: "The request is invalid.",
  INVALID_URL: "Invalid URL.",
  AUTH_REQUIRED: "Authorization token is required.",
  AUTH_PROVIDER_ERROR: "Failed to obtain credentials.",
  CREDENTIALS_BLOCKED: "Refusing to send credentials to this host.",
  SSRF_BLOCKED: "Blocked by SSRF protection.",
  CIRCUIT_OPEN: "Service temporarily unavailable.",
  RATE_LIMITED: "Too many requests.",
  CONCURRENCY_LIMITED: "Too many concurrent requests.",
  RESPONSE_TOO_LARGE: "The response is too large.",
  ENGINE_DISPOSED: "Engine has been disposed.",
  INTERNAL_ERROR: "Internal error.",
  MOCK_NOT_FOUND: "No mock is registered for this request.",
};

export const MESSAGES_FA: Readonly<Record<ErrorCode, string>> = {
  HTTP_ERROR: "سرور با خطا پاسخ داد.",
  NETWORK_ERROR: "ارتباط با سرور برقرار نشد.",
  TIMEOUT: "زمان پاسخ‌گویی سرور به پایان رسید.",
  ABORTED: "درخواست لغو شد.",
  PARSE_ERROR: "پاسخ سرور نامعتبر است.",
  REQUEST_VALIDATION: "اطلاعات ارسالی معتبر نیست.",
  RESPONSE_VALIDATION: "ساختار پاسخ سرور معتبر نیست.",
  REQUEST_INVALID: "درخواست نامعتبر است.",
  INVALID_URL: "آدرس نامعتبر است.",
  AUTH_REQUIRED: "برای این کار باید وارد حساب کاربری شوید.",
  AUTH_PROVIDER_ERROR: "دریافت اطلاعات احراز هویت ناموفق بود.",
  CREDENTIALS_BLOCKED: "ارسال اطلاعات احراز هویت به این مقصد مجاز نیست.",
  SSRF_BLOCKED: "دسترسی به این مقصد مجاز نیست.",
  CIRCUIT_OPEN: "سرویس موقتاً در دسترس نیست. لطفاً کمی بعد دوباره تلاش کنید.",
  RATE_LIMITED: "تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی صبر کنید.",
  CONCURRENCY_LIMITED: "سرور در حال حاضر مشغول است. لطفاً دوباره تلاش کنید.",
  RESPONSE_TOO_LARGE: "حجم پاسخ سرور بیش از حد مجاز است.",
  ENGINE_DISPOSED: "سرویس ارتباطی متوقف شده است.",
  INTERNAL_ERROR: "خطای داخلی رخ داد.",
  MOCK_NOT_FOUND: "برای این درخواست داده‌ی آزمایشی تعریف نشده است.",
};

export type MessageResolver = (code: ErrorCode) => string;

export function createMessageResolver(input: "en" | "fa" | MessageCatalog | undefined): MessageResolver {
  if (input === "fa") return (code) => MESSAGES_FA[code];
  if (input === undefined || input === "en") return (code) => MESSAGES_EN[code];
  return (code) => input[code] ?? MESSAGES_EN[code];
}
