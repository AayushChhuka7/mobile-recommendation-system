import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import "./Login.css";
// import holdingPhone from "../assets/holdingphone2.jpg";
import p1 from "../assets/redmi14c.jpg";
import p2 from "../assets/redmia3.jpg";
import p3 from "../assets/redminote15.jpeg";
import p4 from "../assets/iphone12pm.jpeg";
import p5 from "../assets/pocox3.jpg";
import p6 from "../assets/samsungs26ultra.jpeg";
import p7 from "../assets/samsungs25.jpeg";
import p8 from "../assets/samsungs25ultra.jpeg";
import p9 from "../assets/oneplus13.jpeg";
import p10 from "../assets/samsungs252.jpeg";
import p11 from "../assets/nokia keypad.jpg";
import p12 from "../assets/pop6.jpg";
import p13 from "../assets/nokiag42.jpg";
import p14 from "../assets/spark30c.jpg";
import p15 from "../assets/xiaomi13t.jpg";
import p16 from "../assets/camon40.jpg";
import p17 from "../assets/iphone16.jpg";
import p18 from "../assets/iphonerandom2.jpeg";
import p19 from "../assets/nokia6280.jpg";
import p20 from "../assets/group.jpeg";

import {
  EMPTY_OTP,
  MailIcon,
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  TextField,
  PasswordField,
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
} from "./AuthShared";

const ALL_LOGIN_PHONES = [
  { src: p1, alt: "Redmi 14C" },
  { src: p2, alt: "Redmi A3" },
  { src: p3, alt: "Redmi Note 15" },
  { src: p4, alt: "iPhone 12 Pro Max" },
  { src: p5, alt: "Poco X3" },
  { src: p6, alt: "Samsung Galaxy S26 Ultra" },
  { src: p7, alt: "Samsung Galaxy S25" },
  { src: p8, alt: "Samsung Galaxy S25 Ultra" },
  { src: p9, alt: "OnePlus 13" },
  { src: p10, alt: "Samsung Galaxy S25" },
  { src: p11, alt: "Nokia Keypad" },
  { src: p12, alt: "Tecno Pop 6" },
  { src: p13, alt: "Nokia G42" },
  { src: p14, alt: "Tecno Spark 30C" },
  { src: p15, alt: "Xiaomi 13T" },
  { src: p16, alt: "Tecno Camon 40" },
  { src: p17, alt: "iPhone 16" },
  { src: p18, alt: "iPhone 15" },
  { src: p19, alt: "Nokia 6280" },
  { src: p20, alt: "Group Pic" },
];

function getRandomFourPhones() {
  const shuffled = [...ALL_LOGIN_PHONES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 5);
}

function Login({ onLogin }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleName, setRoleName] = useState("Customer");
  const [loginErrors, setLoginErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [serverError, setServerError] = useState("");
  const [showVerification, setShowVerification] = useState(false);
  const [verificationOtp, setVerificationOtp] = useState(EMPTY_OTP);
  const [verificationError, setVerificationError] = useState("");
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const carouselPhones = useMemo(() => getRandomFourPhones(), []);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const dragStartX = useRef(null);
  const dragDeltaX = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const goToSlide = useCallback(
    (index) => {
      const total = carouselPhones.length;
      setCarouselIndex(((index % total) + total) % total);
    },
    [carouselPhones.length],
  );

  const goNext = useCallback(() => {
    setCarouselIndex((prev) => (prev + 1) % carouselPhones.length);
  }, [carouselPhones.length]);

  const goPrev = useCallback(() => {
    setCarouselIndex(
      (prev) => (prev - 1 + carouselPhones.length) % carouselPhones.length,
    );
  }, [carouselPhones.length]);
  useEffect(() => {
    const timer = setInterval(() => {
      goNext();
    }, 3000);
    return () => clearInterval(timer);
  }, [carouselIndex, goNext]);

  const handleDragStart = (clientX) => {
    dragStartX.current = clientX;
    dragDeltaX.current = 0;
    setIsDragging(true);
  };

  const handleDragMove = (clientX) => {
    if (dragStartX.current === null) return;
    dragDeltaX.current = clientX - dragStartX.current;
  };

  const handleDragEnd = () => {
    if (dragStartX.current === null) return;
    const threshold = 50;
    if (dragDeltaX.current > threshold) {
      goPrev();
    } else if (dragDeltaX.current < -threshold) {
      goNext();
    }
    dragStartX.current = null;
    dragDeltaX.current = 0;
    setIsDragging(false);
  };

  useEffect(() => {
    const savedEmail = localStorage.getItem("rememberedEmail");
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const timer = setTimeout(
      () => setResendCooldown((current) => current - 1),
      1000,
    );
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const validateLogin = useCallback(() => {
    const e = {};
    if (!email) e.email = "Email is required";
    else if (!EMAIL_REGEX.test(email)) e.email = "Enter a valid email address";
    if (!password) e.password = "Password is required";
    else if (password.length < PASSWORD_MIN_LENGTH)
      e.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    else if (!PASSWORD_RULES.test(password))
      e.password =
        "Password must include uppercase, lowercase, number, and special character";
    return e;
  }, [email, password]);

  const handleResendVerification = useCallback(async () => {
    setResendLoading(true);
    setVerificationError("");
    try {
      await api.post("/auth/resend-verification", { email });
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setVerificationOtp(EMPTY_OTP);
    } catch (error) {
      setVerificationError(
        error.response?.data?.message ||
          "Couldn't send a new verification code.",
      );
    } finally {
      setResendLoading(false);
    }
  }, [email]);

  const handleLoginSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      setServerError("");

      const validationErrors = validateLogin();
      setLoginErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      if (rememberMe) {
        localStorage.setItem("rememberedEmail", email);
      } else {
        localStorage.removeItem("rememberedEmail");
      }

      setLoading(true);
      try {
        const response = await api.post("/auth/login", {
          email,
          password,
          roleName,
        });
        if (onLogin) {
          onLogin(response.data);
        }
      } catch (error) {
        console.error("Login error:", error);

        if (error.response) {
          const msg = error.response.data?.message || "Login failed";
          setServerError(msg);
          // If the BE says the account exists but isn't verified, hand the
          // user off to the dedicated /register/otp page (the same one
          // the registration flow lands on) instead of rendering an
          // inline OTP block here. The OTP page pre-fills its email from
          // location.state.email, so the user can just enter the code
          // without re-typing anything.
          if (
            error.response.data?.code === "AUTH_NOT_AUTHENTICATED" &&
            /verify your account/i.test(msg) &&
            email
          ) {
            navigate("/register/otp", {
              state: { email, fromLogin: true },
              replace: true,
            });
            return;
          }
        } else if (error.request) {
          setServerError("Cannot connect to server. Please try again.");
        } else {
          setServerError("Something went wrong. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    },
    [
      email,
      password,
      rememberMe,
      roleName,
      validateLogin,
      onLogin,
      handleResendVerification,
      navigate,
    ],
  );

  const handleVerificationOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setVerificationOtp((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
    setVerificationError("");
    if (value && index < OTP_LENGTH - 1) {
      document.getElementById(`login-verification-otp-${index + 1}`)?.focus();
    }
  }, []);

  const handleVerifyAccount = useCallback(
    async (event) => {
      event.preventDefault();
      const otp = verificationOtp.join("");
      if (otp.length !== OTP_LENGTH) {
        setVerificationError("Please enter the full 6-digit code");
        return;
      }

      setVerificationLoading(true);
      setVerificationError("");
      try {
        await api.post("/auth/verify-account", { email, otp });
        const response = await api.post("/auth/login", {
          email,
          password,
          roleName,
        });
        if (onLogin) onLogin(response.data);
      } catch (error) {
        setVerificationError(
          error.response?.data?.message || "We couldn't verify your account.",
        );
      } finally {
        setVerificationLoading(false);
      }
    },
    [email, password, roleName, onLogin, verificationOtp],
  );

  return (
    <div className="auth-page login-page">
      <div className="login-container">
        <div className="login-left">
          <div
            className="login-carousel"
            onMouseDown={(e) => handleDragStart(e.clientX)}
            onMouseMove={(e) => isDragging && handleDragMove(e.clientX)}
            onMouseUp={handleDragEnd}
            onMouseLeave={() => isDragging && handleDragEnd()}
            onTouchStart={(e) => handleDragStart(e.touches[0].clientX)}
            onTouchMove={(e) => handleDragMove(e.touches[0].clientX)}
            onTouchEnd={handleDragEnd}
          >
            <div
              className="login-carousel-track"
              style={{
                transform: `translateX(-${carouselIndex * 100}%)`,
              }}
            >
              {carouselPhones.map((phone, idx) => (
                <div className="login-carousel-slide" key={idx}>
                  <img
                    src={phone.src}
                    alt={phone.alt}
                    className="login-carousel-image"
                    draggable={false}
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              className="login-carousel-arrow login-carousel-arrow-prev"
              onClick={goPrev}
              aria-label="Previous phone"
            >
              ‹
            </button>
            <button
              type="button"
              className="login-carousel-arrow login-carousel-arrow-next"
              onClick={goNext}
              aria-label="Next phone"
            >
              ›
            </button>

            <div className="login-carousel-dots">
              {carouselPhones.map((_, idx) => (
                <span
                  key={idx}
                  className={`login-carousel-dot ${idx === carouselIndex ? "active" : ""}`}
                  onClick={() => goToSlide(idx)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="login-right">
          <div className="login-form-wrapper">
            <form onSubmit={handleLoginSubmit}>
              <div className="auth-title">Sign in to your account</div>
              <div className="auth-subtitle">
                Welcome back. Enter your credentials to continue.
              </div>

              {serverError && (
                <div
                  className="server-error"
                  style={{
                    background: "#fef2f2",
                    color: "#dc2626",
                    padding: "12px",
                    borderRadius: "8px",
                    marginBottom: "16px",
                    fontSize: "14px",
                  }}
                >
                  {serverError}
                </div>
              )}

              {showVerification && (
                <div className="login-verification-panel">
                  <strong>Verify your email</strong>
                  <p>
                    Enter the code sent to {email} to activate your account.
                  </p>
                  <div
                    className="otp-inputs"
                    role="group"
                    aria-label="Verification code"
                  >
                    {verificationOtp.map((digit, index) => (
                      <input
                        key={index}
                        id={`login-verification-otp-${index}`}
                        className="otp-input"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(event) =>
                          handleVerificationOtpChange(index, event.target.value)
                        }
                        aria-label={`Verification digit ${index + 1}`}
                      />
                    ))}
                  </div>
                  {verificationError && (
                    <div className="otp-error">{verificationError}</div>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary w-full otp-verify-btn"
                    onClick={handleVerifyAccount}
                    disabled={verificationLoading}
                  >
                    {verificationLoading ? "Verifying..." : "Verify account"}
                  </button>
                  <div className="otp-resend">
                    {resendCooldown > 0 ? (
                      <span className="otp-timer">
                        Resend in {resendCooldown}s
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="auth-link"
                        onClick={handleResendVerification}
                        disabled={resendLoading}
                      >
                        {resendLoading ? "Sending..." : "Send a new code"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <TextField
                label="Email address"
                icon={<MailIcon />}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={loginErrors.email}
              />

              <PasswordField
                label="Password"
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={loginErrors.password}
              />

              <div className="form-group role-select-group">
                <label htmlFor="roleName">Login as</label>
                <select
                  id="roleName"
                  name="roleName"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  className="role-select"
                >
                  <option value="Customer">Customer</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              <div className="login-options">
                <span
                  className="auth-link"
                  onClick={() => navigate("/forgot-password")}
                >
                  Forgot password?
                </span>
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full login-btn"
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>

              <div className="auth-footer">
                Don't have an account?{" "}
                <span
                  className="auth-link"
                  onClick={() => navigate("/register")}
                >
                  Create one
                </span>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
