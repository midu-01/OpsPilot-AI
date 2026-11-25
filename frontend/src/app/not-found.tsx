import { PageShell } from "@/components/shell/page-shell";
import { NotFoundState } from "@/components/states/not-found-state";
import { getCurrentUser } from "@/server/session";

/** Unknown URLs. This renders outside the console and sign-in layouts, so it brings its own header. */
export default async function NotFound() {
  return (
    <PageShell session={await getCurrentUser()}>
      <NotFoundState title="Page not found" message="There is nothing at this address." />
    </PageShell>
  );
}
