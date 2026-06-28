// import "dotenv/config";

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import express from "express";
import { router } from "./routes/main.mjs";
import cookieParser from "cookie-parser";
import session from "express-session";
import passport from "passport";
import { errorHandler } from "./middleware/errorHandler.mjs";
import connectPgSimple from "connect-pg-simple";

import cors from "cors";

const PgStore = connectPgSimple(session);
const store = new PgStore({
  conString: process.env.DATABASE_URL,
  createTableIfMissing: true,
});

const PORT = process.env.PORT || 8001;
const cookieSecret = process.env.COOKIE_SECRET;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(cookieParser());

app.use(
  session({
    store: store,
    secret: cookieSecret,
    saveUninitialized: false,
    resave: false,
    cookie: {
      secure: false,
      maxAge: 1000 * 60 * 3,
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => {
  return res.send("Home");
});
app.use("/api", router);

app.use((req, res) => {
  return res.send("No PAGE");
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log("Running at port ", PORT);
});

// app.listen(PORT, "0.0.0.0", () => {
//   console.log("Running at port ", PORT);
// });
