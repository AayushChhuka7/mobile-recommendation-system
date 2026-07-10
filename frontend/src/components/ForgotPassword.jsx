import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api from "../services/api";
import "./Login.css";
import {
  MailIcon,
  ChevronLeftIcon,
  TextField,
  PasswordField,
  OtpInputRow,
  Toast,
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  PASSWORD_HINT,
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  EMPTY_OTP,
  TOAST_DURATION_MS,
} from "./AuthShared";

function stepFromPath(pathname) {
  if (pathname.endsWith("/otp")) return 2;
  if (pathname.endsWith("/reset")) return 3;
  return 1;
}

function ForgotPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const forgotStep = stepFromPath(location.pathname);

  // Pre-seed the email from location.state when the user lands directly on a
  // later step (e.g. Change Password from the profile menu, or a deep link).
  // This avoids a useEffect that would have to setState synchronously.
  const [forgotEmail, setForgotEmail] = useState(
    () => location.state?.email || "",
  );
  const [forgotEmailError, setForgotEmailError] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotOtp, setForgotOtp] = useState(EMPTY_OTP);
  const [forgotOtpError, setForgotOtpError] = useState("");
  const [forgotOtpLoading, setForgotOtpLoading] = useState(false);
  const [forgotResendCooldown, setForgotResendCooldown] = useState(0);
  const [forgotResendLoading, setForgotResendLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [newPasswordErrors, setNewPasswordErrors] = useState({});
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState(null);

  useEffect(() => {
    if (forgotResendCooldown <= 0) return;
    const timer = setTimeout(() => setForgotResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [forgotResendCooldown]);

  // Landed on step 2/3 directly (refresh, bookmark) without the email from
  // step 1 in this session — send back to the start of the flow.
  useEffect(() => {
    if (forgotStep > 1 && !forgotEmail) {
      navigate("/forgot-password", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forgotStep]);

  const handleForgotEmailSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      if (!forgotEmail || !EMAIL_REGEX.test(forgotEmail)) {
        setForgotEmailError("Enter a valid email address");
        return;
      }
      setForgotEmailError("");
      setForgotLoading(true);

      try {
        await api.post("/auth/forget", { email: forgotEmail });
        setForgotResendCooldown(RESEND_COOLDOWN_SECONDS);
        navigate("/forgot-password/otp");
      } catch (error) {
        console.error(error);
        setForgotEmailError(
          error.response?.data?.message || "Couldn't send the code",
        );
      } finally {
        setForgotLoading(false);
      }
    },
    [forgotEmail, navigate],
  );

  const handleForgotOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setForgotOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setForgotOtpError("");
    if (value && index < OTP_LENGTH - 1)
      document.getElementById(`forgot-otp-${index + 1}`)?.focus();
  }, []);

  const handleForgotOtpKeyDown = useCallback((index, e) => {
    if (e.key === "Backspace" && !e.target.value && index > 0) {
      document.getElementById(`forgot-otp-${index - 1}`)?.focus();
    }
  }, []);

  const handleForgotOtpPaste = useCallback((e) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, OTP_LENGTH);
    if (new RegExp(`^\\d{${OTP_LENGTH}}$`).test(pastedData)) {
      setForgotOtp(pastedData.split(""));
      document.getElementById(`forgot-otp-${OTP_LENGTH - 1}`)?.focus();
    }
  }, []);

  const handleForgotOtpVerify = useCallback(
    async (e) => {
      e?.preventDefault();
      const otpString = forgotOtp.join("");
      if (otpString.length !== OTP_LENGTH) {
        setForgotOtpError("Please enter the full 6-digit code");
        return;
      }
      setForgotOtpLoading(true);

      try {
        await api.post("/auth/forget/verify", {
          email: forgotEmail,
          otp: otpString,
        });
        navigate("/forgot-password/reset");
      } catch (error) {
        console.error(error);
        setForgotOtpError(
          error.response?.data?.message ||
            "We couldn't verify that code. Please try again.",
        );
      } finally {
        setForgotOtpLoading(false);
      }
    },
    [forgotOtp, forgotEmail, navigate],
  );

  const handleForgotResendOtp = useCallback(async () => {
    setForgotResendLoading(true);
    try {
      await api.post("/auth/forget", { email: forgotEmail });
      setForgotResendCooldown(RESEND_COOLDOWN_SECONDS);
      setForgotOtp(EMPTY_OTP);
      setForgotOtpError("");
    } catch (error) {
      console.error(error);
      alert(error.response?.data?.message || "Couldn't resend the code");
    } finally {
      setForgotResendLoading(false);
    }
  }, [forgotEmail]);

  const handleForgotOtpBack = useCallback(() => {
    setForgotOtp(EMPTY_OTP);
    setForgotOtpError("");
    navigate("/forgot-password");
  }, [navigate]);

  const handleNewPasswordBack = useCallback(() => {
    setNewPasswordErrors({});
    setResetResult(null);
    navigate("/forgot-password/otp");
  }, [navigate]);

  const validateNewPassword = useCallback(() => {
    const e = {};
    if (!newPassword) e.newPassword = "Password is required";
    else if (newPassword.length < PASSWORD_MIN_LENGTH)
      e.newPassword = `Minimum ${PASSWORD_MIN_LENGTH} characters`;
    else if (!PASSWORD_RULES.test(newPassword))
      e.newPassword =
        "Must include uppercase, lowercase, number, and special character";
    if (confirmNewPassword !== newPassword)
      e.confirmNewPassword = "Passwords do not match";
    return e;
  }, [newPassword, confirmNewPassword]);

  const goToLoginAfterReset = useCallback(() => {
    navigate("/login");
  }, [navigate]);

  const handleResetPasswordSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      const validationErrors = validateNewPassword();
      setNewPasswordErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      setResetLoading(true);

      try {
        await api.post("/auth/forget/changePassword", {
          email: forgotEmail,
          newPassword,
          confirmNewPassword,
        });
        setResetResult({
          status: "success",
          message: "Password changed successfully!",
        });
        setTimeout(goToLoginAfterReset, TOAST_DURATION_MS);
      } catch (error) {
        console.error(error);
        setResetResult({
          status: "error",
          message:
            error.response?.data?.message ||
            "Something went wrong. Please try again.",
        });
      } finally {
        setResetLoading(false);
      }
    },
    [
      validateNewPassword,
      forgotEmail,
      newPassword,
      confirmNewPassword,
      goToLoginAfterReset,
    ],
  );

  return (
    <div className="auth-page">
      <Toast
        status={resetResult?.status}
        message={resetResult?.status === "success" ? resetResult.message : null}
        onDone={goToLoginAfterReset}
      />
      <div className="auth-card">
        {forgotStep === 1 && (
          <form onSubmit={handleForgotEmailSubmit}>
            <button
              type="button"
              className="back-btn"
              onClick={() => navigate("/login")}
              aria-label="Back to sign in"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Reset your password</div>
            <div className="auth-subtitle">
              Enter your account email to get an OTP to reset your password.
            </div>

            <TextField
              label="Email address"
              icon={<MailIcon />}
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              error={forgotEmailError}
            />

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={forgotLoading}
            >
              {forgotLoading ? "Sending..." : "Send OTP"}
            </button>

            <div className="auth-footer">
              <span className="auth-link" onClick={() => navigate("/login")}>
                Back to sign in
              </span>
            </div>
          </form>
        )}

        {forgotStep === 2 && (
          <form onSubmit={handleForgotOtpVerify}>
            <button
              type="button"
              className="back-btn"
              onClick={handleForgotOtpBack}
              aria-label="Back to email entry"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Enter the code</div>
            <div className="auth-subtitle">
              We've sent a 6-digit verification code to{" "}
              <strong>{forgotEmail}</strong>
            </div>

            <OtpInputRow
              idPrefix="forgot-otp"
              otp={forgotOtp}
              error={forgotOtpError}
              onChange={handleForgotOtpChange}
              onKeyDown={handleForgotOtpKeyDown}
              onPaste={handleForgotOtpPaste}
            />

            <button
              type="submit"
              className="btn btn-primary w-full otp-verify-btn"
              disabled={forgotOtpLoading}
            >
              {forgotOtpLoading ? "Verifying..." : "Verify Code"}
            </button>

            <div className="otp-resend">
              <span>Didn't receive the code? </span>
              {forgotResendCooldown > 0 ? (
                <span className="otp-timer">
                  Resend in {forgotResendCooldown}s
                </span>
              ) : (
                <span
                  className="auth-link"
                  onClick={
                    forgotResendLoading ? undefined : handleForgotResendOtp
                  }
                >
                  {forgotResendLoading ? "Resending..." : "Resend"}
                </span>
              )}
            </div>
          </form>
        )}

        {forgotStep === 3 && (
          <form onSubmit={handleResetPasswordSubmit}>
            <button
              type="button"
              className="back-btn"
              onClick={handleNewPasswordBack}
              aria-label="Back to code entry"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Set a new password</div>
            <div className="auth-subtitle">
              Enter and confirm your new password.
            </div>

            <PasswordField
              label="New password"
              name="new-password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              error={newPasswordErrors.newPassword}
              hint={PASSWORD_HINT}
            />

            <PasswordField
              label="Re-enter new password"
              name="confirm-new-password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              error={newPasswordErrors.confirmNewPassword}
            />

            {resetResult?.status === "error" && (
              <div className="form-submit-error">{resetResult.message}</div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={resetLoading || resetResult?.status === "success"}
            >
              {resetLoading ? "Saving..." : "Reset Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default ForgotPassword;
