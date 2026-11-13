const VT_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";

async function mainVt(q) {
  const endpoint = (q || {}).endpoint;
  if (!endpoint || !endpoint.startsWith("/")) {
    return { statusCode: 400, body: "endpoint mancante" };
  }
  try {
    const res = await fetch(VT_BASE + endpoint, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14)" }
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: text
    };
  } catch (e) {
    return { statusCode: 502, body: "errore: " + e.message };
  }
}

const handler = async (event) => mainVt(event.queryStringParameters || {});

module.exports = async (req, res) => {
  if (req && req.query && res && typeof res.status === "function") {
    const out = await mainVt(req.query);
    res.status(out.statusCode).setHeader("Content-Type", "application/json").send(out.body);
    return;
  }
  return handler(req);
};
module.exports.handler = handler;
