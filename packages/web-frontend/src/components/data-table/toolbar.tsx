import type { Table } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  searchKey?: string;
  searchPlaceholder?: string;
  resetLabel?: string;
  children?: ReactNode;
}

export function DataTableToolbar<TData>({
  table,
  searchKey,
  searchPlaceholder = "Search…",
  resetLabel = "Reset",
  children,
}: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0;
  const searchColumn = searchKey ? table.getColumn(searchKey) : undefined;

  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-1 items-center space-x-2">
        {searchColumn && (
          <Input
            placeholder={searchPlaceholder}
            value={(searchColumn.getFilterValue() as string) ?? ""}
            onChange={(e) => searchColumn.setFilterValue(e.target.value)}
            className="h-8 w-[150px] lg:w-[250px]"
          />
        )}
        {children}
        {isFiltered && (
          <Button variant="ghost" size="sm" onClick={() => table.resetColumnFilters()}>
            {resetLabel}
            <X className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
