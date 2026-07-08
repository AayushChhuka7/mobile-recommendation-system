import { useState, useEffect } from "react";

export const EMAIL_REGEX = /\S+@\S+\.\S+/;
export const OTP_LENGTH = 6;
export const RESEND_COOLDOWN_SECONDS = 60;
export const EMPTY_OTP = Array(OTP_LENGTH).fill("");
export const OTP_INDEXES = Array.from({ length: OTP_LENGTH }, (_, i) => i);
export const TOAST_DURATION_MS = 1000;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULES =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>]).+$/;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters with one uppercase, one lowercase, one number, and one special character.`;
export const SELF_ASSIGNABLE_ROLES = ["Customer", "Salesman"];
export const NEPAL_CITIES = [
  "Kathmandu",
  "Lalitpur",
  "Bhaktapur",
  "Dharan",
  "Biratnagar",
  "Birgunj",
  "Pokhara",
  "Dhangadi",
];
export const USAGE_OPTIONS = [
  { value: "everyday", label: "Everyday use" },
  { value: "gaming", label: "Gaming" },
  { value: "photography", label: "Photography" },
  { value: "business", label: "Business" },
];

export const MailIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

export const LockIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const EyeIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOffIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

export const UserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export const PhoneIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export const ChevronLeftIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export function TextField({
  label,
  icon,
  error,
  className = "",
  ...inputProps
}) {
  return (
    <div className="input-group">
      <label className="input-label">{label}</label>
      {icon ? (
        <div className="input-with-icon">
          <span className="input-icon">{icon}</span>
          <input
            className={`input-field ${error ? "error" : ""} ${className}`}
            {...inputProps}
          />
        </div>
      ) : (
        <input
          className={`input-field ${error ? "error" : ""} ${className}`}
          {...inputProps}
        />
      )}
      {error && <div className="input-error">{error}</div>}
    </div>
  );
}

// Shared password field: every password / confirm-password input in the app
// now goes through here, which is what gives all of them the eye toggle.
export function PasswordField({
  label,
  error,
  hint,
  className = "",
  ...inputProps
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-group">
      <label className="input-label">{label}</label>
      <div className="input-with-icon password-field">
        <span className="input-icon">
          <LockIcon />
        </span>
        <input
          className={`input-field ${error ? "error" : ""} ${className}`}
          type={visible ? "text" : "password"}
          {...inputProps}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {error && <div className="input-error">{error}</div>}
      {!error && hint && <div className="input-hint">{hint}</div>}
    </div>
  );
}

export function OtpInputRow({
  idPrefix,
  otp,
  error,
  onChange,
  onKeyDown,
  onPaste,
}) {
  return (
    <div className="otp-container">
      <div className="otp-inputs" onPaste={onPaste}>
        {OTP_INDEXES.map((index) => (
          <input
            key={index}
            id={`${idPrefix}-${index}`}
            className={`otp-input ${error ? "error" : ""}`}
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={1}
            value={otp[index]}
            onChange={(e) => onChange(index, e.target.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
            autoFocus={index === 0}
            aria-label={`Digit ${index + 1} of verification code`}
          />
        ))}
      </div>
      {error && <div className="otp-error">{error}</div>}
    </div>
  );
}

export function Toast({ status, message, onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => {
      onDone?.();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDone]);

  if (!message) return null;

  const isSuccess = status === "success";

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 18px",
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 500,
        color: "#fff",
        backgroundColor: isSuccess ? "#16a34a" : "#dc2626",
        boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
        maxWidth: "90vw",
      }}
    >
      <span aria-hidden="true">{isSuccess ? "✓" : "!"}</span>
      <span>{message}</span>
    </div>
  );
}
