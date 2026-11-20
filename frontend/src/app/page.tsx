import BrowserConnection from "./browser-connection";
import { checkReadiness } from "../lib/api";

export const dynamic = "force-dynamic";

export default async function Workspace() {
  const ready = await checkReadiness(process.env.API_INTERNAL_URL ?? "http://localhost:8000");
  const browserOrigin = process.env.BROWSER_API_BASE_URL ?? "http://localhost:8000";
  return (
    <>
      <header><div className="brand"><span className="mark" aria-hidden="true">O</span> OpsPilot</div><span>Local workspace</span></header>
      <main>
        <h1>Agent Run Console</h1>
        <section aria-labelledby="connection">
          <h2 id="connection">Workspace connections</h2>
          <dl>
            <div><dt>Frontend</dt><dd>Online</dd></div>
            <div><dt>Backend &amp; database</dt><dd className={ready ? "ready" : "offline"}>{ready ? "Connected" : "Unavailable"}</dd></div>
            <div><dt>Browser to API</dt><BrowserConnection apiOrigin={browserOrigin} /></div>
          </dl>
          <form action="/" method="get"><button type="submit">Refresh status</button></form>
        </section>
      </main>
    </>
  );
}
