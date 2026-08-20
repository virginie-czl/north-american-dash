/**
 * The rail's notes on an event or a booking.
 *
 * Same store as the tracker's comments — this is the paper rendering of it,
 * sitting where the design puts it: what someone wrote down about this file,
 * and a way to add to it.
 */
import { useState } from "react";
import { OutlineButton, PaperLink } from "./paper";
import {
  useAddComment,
  useCurrentUser,
  useDeleteComment,
  useEventComments,
} from "@/lib/use-annotations";

/** ISO to `2026-08-18`. The rail never needs more precision than the day. */
function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return value.slice(0, 10);
}

/**
 * The rail's notes: what someone wrote down about this event, and a way to add
 * to it. Same store as the old comments panel — this is the paper rendering of
 * it, sitting where the design puts it.
 */
export function EventNotes({ eventRef }: { eventRef: string }) {
  const { data: user } = useCurrentUser();
  const { data: comments, isLoading } = useEventComments(eventRef);
  const addComment = useAddComment(eventRef);
  const deleteComment = useDeleteComment(eventRef);
  const [body, setBody] = useState("");
  const [writing, setWriting] = useState(false);

  const submit = () => {
    const text = body.trim();
    if (!text || addComment.isPending) return;
    addComment.mutate(text, {
      onSuccess: () => {
        setBody("");
        setWriting(false);
      },
    });
  };

  return (
    <div className="mt-3">
      {isLoading && <p className="py-3 text-[13px] text-paper-muted">Loading…</p>}
      {!isLoading && (comments?.length ?? 0) === 0 && !writing && (
        <p className="py-3 text-[13px] text-paper-muted">No note on this event yet.</p>
      )}
      {comments?.map((c) => (
        <div key={c.id} className="border-b border-paper-hairline py-3.5">
          <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-paper-body">
            {c.body}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[12px] text-paper-muted">
            <span>{c.user_name || c.user_email}</span>
            <span>·</span>
            <span>{fmtDate(c.created_at)}</span>
            {user?.id === c.user_id && (
              <button
                type="button"
                onClick={() => deleteComment.mutate(c.id)}
                disabled={deleteComment.isPending}
                className="ml-auto underline-offset-[3px] hover:underline"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      {writing ? (
        <div className="mt-3">
          <textarea
            value={body}
            autoFocus
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setWriting(false);
            }}
            rows={3}
            placeholder={user ? "⌘/Ctrl + Enter to save" : "Sign in to write a note"}
            disabled={!user || addComment.isPending}
            className="w-full resize-y border border-paper-rule-strong bg-white px-2.5 py-2 text-[13px] outline-none placeholder:text-paper-label"
          />
          <div className="mt-2 flex items-center gap-3">
            <OutlineButton
              size="inline"
              onClick={submit}
              disabled={!user || !body.trim() || addComment.isPending}
            >
              {addComment.isPending ? "Saving…" : "Save the note"}
            </OutlineButton>
            <PaperLink onClick={() => setWriting(false)}>Cancel</PaperLink>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setWriting(true)}
          className="mt-3.5 inline-block border-b border-paper-ink pb-0.5 text-[13px]"
        >
          Add a note
        </button>
      )}
      {addComment.isError && (
        <p role="alert" className="mt-2 text-[12.5px] text-paper-alert">
          Note not saved: {String((addComment.error as Error)?.message ?? addComment.error)}
        </p>
      )}
    </div>
  );
}
