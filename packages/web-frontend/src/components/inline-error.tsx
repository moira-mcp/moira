import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";

interface InlineErrorProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function InlineError({
  title = "Error",
  message,
  onRetry,
  retryLabel = "Retry",
}: InlineErrorProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>{message}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {retryLabel}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
