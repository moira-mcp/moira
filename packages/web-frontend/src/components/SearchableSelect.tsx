/**
 * SearchableSelect — Combobox-style select with text filtering.
 * Use instead of plain Select when the option list can grow (users, workflows, etc.).
 * Its viewport-bounded overlay flips above the trigger; scrollable forms can keep options inline.
 */

import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  /** Classes of the dropdown list, e.g. `w-full` to match a trigger that fills its container. */
  contentClassName?: string;
  testId?: string;
  /** Scrollable forms can keep the options in their own layout instead of overlapping fields. */
  positioning?: "overlay" | "inline";
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  className,
  contentClassName,
  testId,
  positioning = "overlay",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState({ above: false, height: 260 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const flip = positioning === "overlay" && below < 260 && above > below;
      setPlacement({
        above: flip,
        height: Math.max(0, Math.min(260, (flip ? above : below) - 52)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, positioning]);

  const selectedLabel = useMemo(() => {
    const found = options.find((opt) => opt.value === value);
    return found?.label;
  }, [options, value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        ref={triggerRef}
        variant="outline"
        role="combobox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("w-[200px] justify-between font-normal", className)}
        data-testid={testId}
      >
        <span className="min-w-0 truncate">
          {selectedLabel ?? <span className="text-muted-foreground">{placeholder}</span>}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
      {open && (
        <div
          data-slot="popover-content"
          className={cn(
            "left-0 z-50 w-[200px] max-w-full rounded-md border bg-popover shadow-md animate-in fade-in-0 zoom-in-95",
            positioning === "inline"
              ? "relative mt-1"
              : placement.above
                ? "absolute bottom-full mb-1"
                : "absolute top-full mt-1",
            contentClassName,
          )}
        >
          <Command>
            <CommandInput placeholder={searchPlaceholder} autoFocus />
            <CommandList
              style={{
                maxHeight: positioning === "inline" ? "min(260px, 40dvh)" : placement.height,
              }}
            >
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === option.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
