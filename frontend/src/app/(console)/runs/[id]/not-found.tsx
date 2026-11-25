import { NotFoundState } from "@/components/states/not-found-state";

/** notFound() in page.tsx renders this for a 404 or a malformed run ID (422). */
export default function RunNotFound() {
  return (
    <NotFoundState
      title="Run not found"
      message="No run has this ID. It may be mistyped, or the database was reset since the link was made."
    />
  );
}
