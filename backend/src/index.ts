import dotenv from "dotenv";
import express, { json, Request, Response, urlencoded } from "express";

import { router } from "./routes/mainRoute";

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT) | 3000;

app.use(json());
app.use(urlencoded({ extended: true }));

app.use("/", router);

app.use((req: Request, res: Response) => {
  res.send("NOT FOUND PAGE");
});

app.listen(PORT, () => {
  console.log(`running server in ${PORT}`);
});
