const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h1>WhatsClone is working ✅</h1>
    <p>Server file is correct now.</p>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
