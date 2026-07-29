import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type TagFilterGroup = { label: string; options: Array<{ value: string; label: string }> };

/**
 * Tag filter as a checklist instead of a single-value dropdown: each tag can be
 * toggled on or off independently, and several can be active at once (OR — a
 * row matches if it carries any selected tag). Selecting an item keeps the
 * menu open (onSelect is prevented) so multiple picks don't require reopening.
 */
export function TagFilterSelect({
  groups,
  selected,
  onChange,
}: {
  groups: TagFilterGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const allOptions = groups.flatMap((g) => g.options);
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const triggerLabel =
    selected.length === 0
      ? "Filtrer par tag"
      : selected.length === 1
        ? (allOptions.find((o) => o.value === selected[0])?.label ?? "1 tag")
        : `${selected.length} tags sélectionnés`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 w-[200px] justify-between font-normal">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-[240px] overflow-y-auto">
        <DropdownMenuItem
          disabled={selected.length === 0}
          onSelect={() => onChange([])}
          className="text-muted-foreground"
        >
          Effacer la sélection{selected.length > 0 ? ` (${selected.length})` : ""}
        </DropdownMenuItem>
        {groups.map((g) => (
          <div key={g.label}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{g.label}</DropdownMenuLabel>
            {g.options.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.value}
                checked={selected.includes(o.value)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => toggle(o.value)}
              >
                {o.label}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
