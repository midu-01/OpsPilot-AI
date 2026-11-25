"use client";

import { RouteError } from "@/components/states/route-error";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="This page could not be displayed" error={error} retry={retry} />;
}
