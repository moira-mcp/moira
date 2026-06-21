import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SparkAreaChart } from "@tremor/react";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: number[];
  className?: string;
  onClick?: () => void;
}

export function StatCard({ label, value, icon: Icon, trend, className, onClick }: StatCardProps) {
  return (
    <Card
      className={cn(
        "transition-all duration-200",
        onClick && "cursor-pointer hover:shadow-md hover:-translate-y-0.5",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between gap-2">
          <div className="text-2xl font-bold">
            {typeof value === "number" ? <NumberTicker value={value} /> : value}
          </div>
          {trend && trend.length > 1 && (
            <SparkAreaChart
              data={trend.map((v, i) => ({ index: i, value: v }))}
              categories={["value"]}
              index="index"
              className="h-8 w-20"
              colors={["indigo"]}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
