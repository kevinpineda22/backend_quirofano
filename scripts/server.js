import process from "node:process";
import app from "../app.js";

const port = Number(process.env.PORT || 3030);
app.listen(port, "127.0.0.1", () => {
  console.log(`Quirofano: http://127.0.0.1:${port}/api/salud`);
});
