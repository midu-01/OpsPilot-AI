"use client";

import { RouteError } from "@/components/states/route-error";

export default function RunError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="This run could not be displayed" error={error} retry={retry} />;
}
