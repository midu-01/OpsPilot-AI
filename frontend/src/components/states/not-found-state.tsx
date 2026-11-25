import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

interface NotFoundStateProps {
  title: string;
  message: string;
}

export function NotFoundState({ title, message }: NotFoundStateProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <span className="grid size-11 place-items-center rounded-full border border-border bg-surface-2 text-muted">
        <SearchX aria-hidden className="size-5" />
      </span>
      <h1 className="mt-4 text-base font-semibold text-fg">{title}</h1>
      <p className="mt-1 text-sm text-muted">{message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link href="/runs" className={buttonClasses("primary")}>
          See all runs
        </Link>
        <Link href="/" className={buttonClasses("secondary")}>
          Start a new run
        </Link>
      </div>
    </div>
  );
}
