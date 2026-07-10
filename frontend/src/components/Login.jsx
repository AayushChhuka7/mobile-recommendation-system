import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import "./Login.css";
import holdingPhone from "../assets/holdingphone2.jpg";
import redmi14 from "../assets/redmi14c.jpg";
import {
  MailIcon,
  TextField,
  PasswordField,
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
} from "./AuthShared";

function Login({ onLogin }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Role is chosen at registration, not on the login page. Kept here so the
  // /auth/login request body still matches the backend contract.
  const roleName = "Customer";
  const [loginErrors, setLoginErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    const savedEmail = localStorage.getItem("rememberedEmail");
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
  }, []);

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

        // Let App.jsx handle navigation via onLogin
        if (onLogin) {
          onLogin(response.data);
        }
      } catch (error) {
        console.error("Login error:", error);

        if (error.response) {
          const msg = error.response.data?.message || "Login failed";
          setServerError(msg);
        } else if (error.request) {
          setServerError("Cannot connect to server. Please try again.");
        } else {
          setServerError("Something went wrong. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    },
    [email, password, rememberMe, validateLogin, onLogin],
  );

  return (
    <div className="auth-page login-page">
      <div className="login-container">
        <div
          className="login-left"
          style={{ backgroundImage: `url(${holdingPhone})` }}
        >
          <div className="login-overlay">
            <div className="brand-tagline">
              <h1>Welcome to</h1>
              <h2>Mobile Phone Recommendation System</h2>
              <p>Get mobile phones recommended instantly</p>
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

              <TextField
                label="Email address"
                icon={<MailIcon />}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
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

              <div className="login-options">
                <label className="remember-me">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                  />
                  Remember me
                </label>
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
