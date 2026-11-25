"use client";

import { RouteError } from "@/components/states/route-error";

export default function RunsError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="The runs page could not be displayed" error={error} retry={retry} />;
}
