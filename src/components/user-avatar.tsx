/**
 * Avatar for a Naboo user.
 *
 * The Google profile photo comes from the OAuth id_token. Those URLs are hotlinked
 * from lh3.googleusercontent.com, which needs `referrerPolicy="no-referrer"` to
 * avoid 403s, and they can rotate or disappear — so a failed load falls back to
 * initials rather than leaving a broken image.
 */
import { useState } from "react";

export function userInitials(name?: string | null, email?: string | null): string {
  const base = (name ?? email ?? "").trim();
  if (!base) return "?";
  const parts = base.split(/[\s._@-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join("") || base.charAt(0).toUpperCase()
  );
}

export function UserAvatar({
  name,
  email,
  picture,
  className = "h-8 w-8",
  fallbackClassName = "bg-navy text-naboo",
  textClassName = "text-[11px]",
  title,
}: {
  name?: string | null;
  email?: string | null;
  picture?: string | null;
  /** Size and shape utilities; applied to both the photo and the fallback. */
  className?: string;
  fallbackClassName?: string;
  textClassName?: string;
  title?: string;
}) {
  const [broken, setBroken] = useState(false);
  const label = title ?? name ?? email ?? undefined;

  if (picture && !broken) {
    return (
      <img
        src={picture}
        alt={name ?? email ?? ""}
        title={label}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setBroken(true)}
        className={`flex-none rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      title={label}
      aria-label={label}
      className={`flex flex-none items-center justify-center rounded-full font-bold ${fallbackClassName} ${textClassName} ${className}`}
    >
      {userInitials(name, email)}
    </span>
  );
}
