import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";

import healthRouter from "./routes/health.js";
import authRouter from "./routes/auth.js";
import adsRouter from "./routes/ads.js";
import tasksRouter from "./routes/tasks.js";
import withdrawalsRouter from "./routes/withdrawals.js";
import adminRouter from "./routes/admin.js";
import { ApiError } from "./utils/http.js";
import { readDeviceFingerprint } from "./middleware/auth.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "5000", 10);
const frontendUrl = process.env.FRONTEND_URL ?? process.env.CLIENT_URL ?? "http://localhost:5173";

app.use(helmet());
app.use(compression());
app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));
app.use(readDeviceFingerprint);

app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/ads", adsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/withdrawals", withdrawalsRouter);
app.use("/api/admin", adminRouter);

app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const error = err instanceof ApiError ? err : new ApiError(500, err instanceof Error ? err.message : "Internal server error");
  if (error.statusCode >= 500) console.error("[Error]", err);
  res.status(error.statusCode).json({ success: false, error: error.message, details: error.details });
});

app.listen(PORT, () => {
  console.log(`AdEarn server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV ?? "development"}`);
  console.log(`Allowed CORS: ${frontendUrl}`);
});

export default app;
