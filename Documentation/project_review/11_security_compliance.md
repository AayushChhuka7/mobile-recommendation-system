# 11 — Security & Compliance Review

> The project ships a customer-facing recommendation service. This document
> lists the security and compliance issues found in a code review and the
> fixes.

---

## 1. PII in the dataset (HIGH severity)

The dataset `dataset/customer_dataset.csv` contains:

- `customer_name` (full name, 4,557 entries)
- `city` (90 distinct Nepal cities)
- `purchase_date`, `last_active_at` (timestamps)
- `browsing_history` (could include sensitive categories)
- `accessories_purchased` (could include health-related items)
- `payment_method` (could include partial card numbers in some systems)

**Risk.** If the dataset is published on GitHub, this is a **GDPR / data-protection breach**.

**Fixes.**
1. **Hash `customer_id`** with SHA-256 before publishing. Keep `customer_id` for joins but make it irreversible.
2. **Drop `customer_name` and `city`** from any published file.
3. **Truncate `browsing_history`** to category-level (already the case) but **drop specific viewed timestamps**.
4. **Document the licence.** "Personal/educational use only; redistribution prohibited."

---

## 2. Auth & session (MEDIUM severity)

### 2.1 What is good

- Passport-Local with session cookies.
- `connect.sid` cookie, HTTP-only assumed (verify).
- OTP for registration / password reset.
- Role-based access (RBAC Phase 1).
- bcrypt for passwords (verify the cost factor).

### 2.2 What is weak

- **No rate limit on `/auth/*`.** An attacker can brute-force OTPs (6 digits = 1M combinations) or passwords (no lockout).
- **OTP expiry is "expires_at" — but is it enforced?** The `Otp.isUsed` flag prevents reuse, but if `expiresAt` is not checked, an OTP can be valid forever until used.
- **`resend-OTP` returns 404 instead of 409** for already-verified users (per `FUTURE_WORK.md`). Should be 409.
- **No CSRF protection** on session-cookie routes. Express has `csurf` middleware; consider it.
- **CORS = "*"** on FastAPI. Tighten to specific origins.

### 2.3 Fixes

```javascript
// rate-limit /auth/*
import rateLimit from "express-rate-limit";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many auth attempts. Try again in 15 minutes.",
});

app.use("/api/auth", authLimiter);
```

For the FastAPI service:

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "https://yourdomain.com"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

---

## 3. Input validation (MEDIUM severity)

### 3.1 The good

- Pydantic models on FastAPI for request validation.
- Express-validator on backend (verify).

### 3.2 The weak

- **`recommendService.mjs` does `prisma.phones.findFirst({ where: { modelName: { contains: item.Model } } })`** with `mode: "insensitive"`. If `item.Model` contains characters that Postgres treats specially (e.g., `%`, `_`), this becomes a **SQL injection-style** information disclosure.
- **No length cap on user input** — a 10 MB `wishlist` JSON would still parse.
- **No sanitisation on output** — XSS via `modelName` if it's ever rendered raw.

### 3.3 Fixes

```javascript
// escape LIKE wildcards
const escaped = item.Model.replace(/[%_]/g, "\\$&");

// cap input length
if (rawString.length > 1000) throw badRequest("input too long");
```

```python
# cap Pydantic string fields
from pydantic import Field
class PredictRequest(BaseModel):
    raw: Dict[str, Any] = Field(..., max_length=10000)
```

---

## 4. Database (MEDIUM severity)

### 4.1 The good

- Parameterised queries via Prisma — no raw SQL injection.
- Indexes on `phones.antutuScore`, `phones.isActive`, `phones.(brandId, modelName)` unique.
- `@@map` everywhere — snake_case in DB, camelCase in code.

### 4.2 The weak

- **Generated Prisma client is in `src/generated/prisma/`** — fine, but `.gitignore` excludes it. A fresh clone fails. Add `prisma generate` to `postinstall`.
- **No backup policy** for PostgreSQL data.
- **No encryption at rest** for sensitive columns (`password` is bcrypt-hashed ✅, but `phoneNo` is plain text — verify GDPR compliance).

### 4.3 Fixes

```json
// backend/package.json
"scripts": {
  "postinstall": "prisma generate",
  ...
}
```

---

## 5. FastAPI service (LOW severity)

### 5.1 The good

- Pydantic validation on all routes.
- Proper HTTP status codes (400, 404, 503).
- Global error envelope.

### 5.2 The weak

- **CORS = "*"**.
- **No authentication.** The `/recommend` endpoint is open. For an internal demo this is fine; for production, add API-key auth or JWT.
- **No request size limit.** A 100 MB JSON body could be sent.

### 5.3 Fixes

```python
from fastapi.middleware.trustedhost import TrustedHostMiddleware
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["ml.yourdomain.com"])

# Cap request size via uvicorn: --limit-max-requests 1000
```

---

## 6. Frontend (LOW severity)

### 6.1 The good

- React 19 (no XSS by default if not using `dangerouslySetInnerHTML`).
- Sessions via HTTP-only cookies (assumed).

### 6.2 The weak

- **Static asset URLs in `frontend/src/assets/`** are bundled. If they leak into production builds, no security issue per se, but they reveal product imagery.
- **`localStorage` for tokens** (verify — I haven't seen it). Use HTTP-only cookies.
- **No CSP header.** Add `Content-Security-Policy: default-src 'self'; img-src 'self' data: https://cdn.yourdomain.com;`.

---

## 7. Secrets (MEDIUM severity)

### 7.1 The good

- `.env` exists and is `.gitignore`-ed.
- `.env.example` is provided.

### 7.2 The weak

- **`backend/.env.example`** — verify it doesn't ship real secrets.
- **Docker compose** — verify no hardcoded passwords.
- **ML service** — `ML_BASE_URL` may be in `.env`. Verify it doesn't ship.

### 7.3 Fixes

- Add `git-secrets` to pre-commit hooks.
- Use **GitHub Actions secrets** for CI.
- Rotate any leaked credentials immediately.

---

## 8. OWASP Top-10 mapping

| OWASP issue                              | Present?  | Severity |
| ---------------------------------------- | --------- | -------- |
| A01 Broken Access Control                | Partial (RBAC exists) | Medium |
| A02 Cryptographic Failures               | bcrypt ✅, sessions ✅ | Low |
| A03 Injection                            | Prisma ✅, LIKE wildcard ⚠ | Medium |
| A04 Insecure Design                      | No rate limiting on /auth | High |
| A05 Security Misconfiguration            | CORS=*, default Swagger | Medium |
| A06 Vulnerable Components                | pin versions in package.json | Low |
| A07 Identification & Auth Failures       | No rate limit, OTP reuse check ✅ | Medium |
| A08 Software & Data Integrity Failures   | No integrity check on model.json | Low |
| A09 Security Logging & Monitoring        | `console.log` everywhere, no SIEM | High |
| A10 Server-Side Request Forgery          | No outbound calls from /predict | Low |

---

## 9. Compliance checklist (GDPR-style)

- [ ] **Lawful basis** for processing PII documented.
- [ ] **Right to erasure** — `DELETE /users/:id` cascades, but verify PII columns are also deleted from `Wishlist`, `RecommendationHistory`, etc.
- [ ] **Right to data portability** — `GET /users/:id/export` returns a JSON dump.
- [ ] **Data retention policy** — `RecommendationHistory` rows older than 2 years deleted nightly.
- [ ] **Consent for cookies** — Cookie banner on first visit.
- [ ] **DPO contact** in the privacy policy.
- [ ] **Encryption at rest** for `phoneNo`, `email`.
- [ ] **Breach notification** procedure documented.

---

## 10. Summary

The project has the bones of a secure system (Prisma parameterised queries, bcrypt, RBAC) but is missing the **defensive** layers (rate limiting, CSRF, CSP, request size limits). For a BCT minor, fixing the top-5 (rate limit, CORS, PII hashing, OTP expiry enforcement, request size cap) is enough.

| Priority | Fix                                               | Effort    |
| -------- | ------------------------------------------------- | --------- |
| 1        | Hash / drop PII in published dataset             | 0.5 day   |
| 2        | Rate-limit `/auth/*`                              | 1 hour    |
| 3        | Tighten CORS on FastAPI                            | 5 minutes |
| 4        | Enforce `Otp.expiresAt` in middleware              | 1 hour    |
| 5        | Add request-size cap on FastAPI                    | 5 minutes |
| 6        | Escape LIKE wildcards in `recommendService`       | 30 minutes |
| 7        | `prisma generate` in `postinstall`                | 5 minutes |
| 8        | Add CSP header in Vite config                      | 30 minutes |

After these, the project is safe to demo in front of an external audience.