import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api from "../services/api";
import "./Login.css";
import {
  MailIcon,
  UserIcon,
  PhoneIcon,
  ChevronLeftIcon,
  TextField,
  PasswordField,
  OtpInputRow,
  Toast,
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  PASSWORD_HINT,
  SELF_ASSIGNABLE_ROLES,
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  EMPTY_OTP,
  TOAST_DURATION_MS,
} from "./AuthShared";

const REGISTER_ROLE_OPTIONS = [...SELF_ASSIGNABLE_ROLES, "Admin"];

function Registration({ onLogin }) {
  const navigate = useNavigate();
  const location = useLocation();
  const step = location.pathname.endsWith("/otp") ? 2 : 1;

  const [registerData, setRegisterData] = useState({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
  });
  const [registerRole, setRegisterRole] = useState("Customer");
  const [registerErrors, setRegisterErrors] = useState({});
  const [registerLoading, setRegisterLoading] = useState(false);

  const [otp, setOtp] = useState(EMPTY_OTP);
  const [otpError, setOtpError] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [otpResult, setOtpResult] = useState(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);
  useEffect(() => {
    if (step === 2 && !registerData.email) {
      navigate("/register", { replace: true });
    }
  }, [step]);

  const validateRegister = useCallback(() => {
    const e = {};
    if (!registerData.username) e.username = "Username is required";
    if (!registerData.email || !EMAIL_REGEX.test(registerData.email))
      e.email = "Valid email required";
    if (!registerData.password) e.password = "Password is required";
    else if (registerData.password.length < PASSWORD_MIN_LENGTH)
      e.password = `Minimum ${PASSWORD_MIN_LENGTH} characters`;
    else if (!PASSWORD_RULES.test(registerData.password))
      e.password =
        "Must include uppercase, lowercase, number, and special character";
    if (registerData.confirmPassword !== registerData.password)
      e.confirmPassword = "Passwords do not match";
    if (registerData.phone && !/^\+?[0-9\s-]{7,15}$/.test(registerData.phone))
      e.phone = "Enter a valid phone number";
    return e;
  }, [registerData]);

  const handleRegisterNext = useCallback(
    async (e) => {
      e?.preventDefault();
      const validationErrors = validateRegister();
      setRegisterErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      setRegisterLoading(true);
      try {
        await api.post("/auth/register", {
          name: registerData.username,
          email: registerData.email,
          password: registerData.password,
          confirmPassword: registerData.confirmPassword,
          phoneNo: registerData.phone,
          roleName: registerRole,
        });

        setResendCooldown(RESEND_COOLDOWN_SECONDS);
        navigate("/register/otp");
      } catch (error) {
        console.error(error);
        const serverErrors = error.response?.data?.errors;
        if (serverErrors && typeof serverErrors === "object") {
          setRegisterErrors(serverErrors);
        } else {
          alert(error.response?.data?.message || "Registration failed");
        }
      } finally {
        setRegisterLoading(false);
      }
    },
    [registerData, registerRole, validateRegister, navigate],
  );

  const handleOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setOtpError("");
    if (value && index < OTP_LENGTH - 1)
      document.getElementById(`otp-${index + 1}`)?.focus();
  }, []);

  const handleOtpKeyDown = useCallback((index, e) => {
    if (e.key === "Backspace" && !e.target.value && index > 0) {
      document.getElementById(`otp-${index - 1}`)?.focus();
    }
  }, []);

  const handleOtpPaste = useCallback((e) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, OTP_LENGTH);
    if (new RegExp(`^\\d{${OTP_LENGTH}}$`).test(pastedData)) {
      setOtp(pastedData.split(""));
      document.getElementById(`otp-${OTP_LENGTH - 1}`)?.focus();
    }
  }, []);

  const completeRegistration = useCallback(() => {
    onLogin({
      id: registerData.email,
      name: registerData.username,
      email: registerData.email,
      roleName: registerRole,
    });
  }, [registerData, registerRole, onLogin]);

  const handleOtpVerify = useCallback(
    async (e) => {
      e?.preventDefault();
      const otpString = otp.join("");
      if (otpString.length !== OTP_LENGTH) {
        setOtpError("Please enter the full 6-digit code");
        return;
      }
      setOtpLoading(true);
      setOtpError("");

      try {
        await api.post("/auth/verify", {
          email: registerData.email,
          otp: otpString,
        });

        try {
          await api.post("/auth/login", {
            email: registerData.email,
            password: registerData.password,
            roleName: registerRole,
          });
        } catch (loginErr) {
          console.error("auto-login after verify failed", loginErr);
        }

        setOtpResult({
          status: "success",
          message: "Registration successful!!",
        });
        setTimeout(completeRegistration, TOAST_DURATION_MS);
      } catch (error) {
        console.error(error);
        setOtpResult({
          status: "error",
          message:
            error.response?.data?.message ||
            "We couldn't verify that code. Please try again.",
        });
      } finally {
        setOtpLoading(false);
      }
    },
    [
      otp,
      registerData.email,
      registerData.password,
      registerRole,
      completeRegistration,
    ],
  );

  const handleResendOtp = useCallback(async () => {
    setResendLoading(true);
    try {
      await api.post("/auth/resend", { email: registerData.email });
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setOtp(EMPTY_OTP);
      setOtpError("");
      setOtpResult(null);
    } catch (error) {
      console.error(error);
      alert(error.response?.data?.message || "Couldn't resend the code");
    } finally {
      setResendLoading(false);
    }
  }, [registerData.email]);

  const handleOtpBack = useCallback(() => {
    setOtp(EMPTY_OTP);
    setOtpError("");
    setOtpResult(null);
    navigate("/register");
  }, [navigate]);

  const updateRegister = useCallback((key, value) => {
    setRegisterData((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div className="auth-page">
      <Toast
        status={otpResult?.status}
        message={otpResult?.status === "success" ? otpResult.message : null}
        onDone={completeRegistration}
      />
      <div className="auth-card register-card">
        {step === 1 ? (
          <form onSubmit={handleRegisterNext}>
            <button
              type="button"
              className="back-btn"
              onClick={() => navigate("/login")}
              aria-label="Back to sign in"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Register Now</div>
            <div className="auth-subtitle">
              Create an account to get started
            </div>

            <TextField
              label="Username"
              icon={<UserIcon />}
              placeholder="Enter your username"
              name="username"
              autoComplete="username"
              value={registerData.username}
              onChange={(e) => updateRegister("username", e.target.value)}
              error={registerErrors.username}
            />

            <TextField
              label="Email address"
              icon={<MailIcon />}
              type="email"
              name="email"
              autoComplete="email"
              placeholder="Enter your email"
              value={registerData.email}
              onChange={(e) => updateRegister("email", e.target.value)}
              error={registerErrors.email}
            />

            <PasswordField
              label="Password"
              name="new-password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={registerData.password}
              onChange={(e) => updateRegister("password", e.target.value)}
              error={registerErrors.password}
              hint={PASSWORD_HINT}
            />

            <PasswordField
              label="Re-enter password"
              name="confirm-password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={registerData.confirmPassword}
              onChange={(e) =>
                updateRegister("confirmPassword", e.target.value)
              }
              error={registerErrors.confirmPassword}
            />

            <TextField
              label="Phone number (optional)"
              icon={<PhoneIcon />}
              type="tel"
              name="phone"
              autoComplete="tel"
              value={registerData.phone}
              onChange={(e) => updateRegister("phone", e.target.value)}
              error={registerErrors.phone}
            />

            <div className="input-group">
              <label className="input-label">Register as</label>
              <select
                className="input-field"
                value={registerRole}
                onChange={(e) => setRegisterRole(e.target.value)}
              >
                {REGISTER_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={registerLoading}
            >
              {registerLoading ? "Submitting..." : "Register"}
            </button>

            <div className="auth-footer">
              Already have an account?{" "}
              <span className="auth-link" onClick={() => navigate("/login")}>
                Sign in
              </span>
            </div>
          </form>
        ) : (
          <form onSubmit={handleOtpVerify}>
            <button
              type="button"
              className="back-btn"
              onClick={handleOtpBack}
              aria-label="Back to registration form"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Verify your email</div>
            <div className="auth-subtitle">
              We've sent a 6-digit verification code to{" "}
              <strong>{registerData.email}</strong>
            </div>

            <div className="step-indicator">
              <div className="step-dot active"></div>
              <div className="step-dot active"></div>
            </div>

            <OtpInputRow
              idPrefix="otp"
              otp={otp}
              error={otpError}
              onChange={handleOtpChange}
              onKeyDown={handleOtpKeyDown}
              onPaste={handleOtpPaste}
            />

            {otpResult?.status === "error" && (
              <div className="form-submit-error">{otpResult.message}</div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full otp-verify-btn"
              disabled={otpLoading || otpResult?.status === "success"}
            >
              {otpLoading ? "Verifying..." : "Verify Email"}
            </button>

            <div className="otp-resend">
              <span>Didn't receive the code? </span>
              {resendCooldown > 0 ? (
                <span className="otp-timer">Resend in {resendCooldown}s</span>
              ) : (
                <span
                  className="auth-link"
                  onClick={resendLoading ? undefined : handleResendOtp}
                >
                  {resendLoading ? "Resending..." : "Resend"}
                </span>
              )}
            </div>

            <div className="auth-footer">
              Back to{" "}
              <span className="auth-link" onClick={() => navigate("/login")}>
                Sign in
              </span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default Registration;
