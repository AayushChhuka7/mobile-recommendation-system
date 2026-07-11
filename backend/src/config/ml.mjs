import "dotenv/config";

const ML_BASE_URL = process.env.ML_BASE_URL;

if (!ML_BASE_URL) {
  throw new Error(
    "[ml] ML_BASE_URL is not set. Add ML_BASE_URL=http://127.0.0.1:8002 to backend/.env",
  );
}

export { ML_BASE_URL };
