# احراز هویت

```ts
auth: "token"                                          // ثابت (توکن خالی Bearer می‌شود)
auth: () => getToken()                                 // تابع sync یا async
auth: createApiKeyAuth("k", "X-API-Key")
auth: createBasicAuth("user", "pass")
auth: createRefreshableAuth({ refresh: fetchToken })   // تا انقضا کش می‌شود، تمدید یک‌باره
auth: createOAuth2ClientCredentials({ tokenUrl, clientId, clientSecret, scope })
refreshAuth: async () => newToken                      // هوک اختیاری بعد از 401
```

## الزامی، اختیاری، هیچ

`defaultAuth: true` (پیش‌فرض) یعنی بدون اطلاعات احراز هویت خطای `AUTH_REQUIRED` می‌گیرید.
برای هر درخواست می‌توانید `auth: false`، `auth: "optional"` یا یک `authToken` مشخص بدهید.

## محدوده

اطلاعات احراز هویت engine فقط به originهای `baseUrl` و `credentialHosts` فرستاده می‌شود. برای
host دیگر خطای `CREDENTIALS_BLOCKED` برمی‌گردد و در redirect به origin دیگر **همه‌ی** هدرهای
احراز هویت، حتی هدرهای سفارشی مثل `X-API-Key`، حذف می‌شوند.

## تمدید بعد از 401

بعد از 401، engine فقط **یک بار و به‌صورت مشترک** بین درخواست‌های هم‌زمان توکن را تمدید و
درخواست را تکرار می‌کند: یا با `refreshAuth`، یا اگر provider متد `refreshNow()` داشته باشد،
خودکار. هدرهای اضافی provider بعد از تمدید حفظ می‌شوند.
