// index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// Needed to resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files (like index.html, CSS, JS, images) from "public" folder
app.use(express.static(path.join(__dirname, "public")));

// Example API endpoint
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from your Render backend 🚀" });
});

// Fallback: send index.html for any unknown routes (for SPAs)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
