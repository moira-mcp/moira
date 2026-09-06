import React from "react";
import { useTranslation } from "react-i18next";

/**
 * A node value read against the schema its catalog entry declares.
 *
 * Declared fields retain schema order. Unset declared fields and authored fields missing from the
 * schema remain visibly distinct, which is what makes stale or incomplete workflows diagnosable.
 */
export const NodeSchemaReadout: React.FC<{
  schema: Record<string, unknown> | null;
  value: Record<string, unknown>;
}> = ({ schema, value }) => {
  const { t } = useTranslation();
  const properties =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : null;

  if (!properties) {
    return (
      <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-64">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const declared = Object.keys(properties);
  const undeclared = Object.keys(value).filter((key) => !declared.includes(key));
  const renderValue = (fieldValue: unknown) =>
    typeof fieldValue === "string" ? fieldValue : JSON.stringify(fieldValue, null, 2);

  return (
    <div className="space-y-2">
      {declared.map((key) => {
        const field = properties[key] ?? {};
        const isSet = key in value;
        return (
          <div key={key} className="text-xs">
            <div className="flex items-center gap-1.5">
              <span className="font-medium font-mono">{key}</span>
              {typeof field.type === "string" && (
                <span className="text-muted-foreground">{field.type}</span>
              )}
              {required.includes(key) && (
                <span className="text-destructive">
                  {t("components.workflowSidebar.nodeSchema.required", "required")}
                </span>
              )}
            </div>
            {typeof field.description === "string" && field.description && (
              <div className="text-muted-foreground">{field.description}</div>
            )}
            {isSet ? (
              <pre className="bg-muted p-2 rounded mt-1 overflow-auto max-h-32 whitespace-pre-wrap break-all">
                {renderValue(value[key])}
              </pre>
            ) : (
              <div className="text-muted-foreground italic mt-1">
                {t("components.workflowSidebar.nodeSchema.notSet", "not set")}
              </div>
            )}
          </div>
        );
      })}
      {undeclared.map((key) => (
        <div key={key} className="text-xs">
          <div className="flex items-center gap-1.5">
            <span className="font-medium font-mono">{key}</span>
            <span className="text-chart-4">
              {t(
                "components.workflowSidebar.nodeSchema.notDeclared",
                "not declared by this node type",
              )}
            </span>
          </div>
          <pre className="bg-muted p-2 rounded mt-1 overflow-auto max-h-32 whitespace-pre-wrap break-all">
            {renderValue(value[key])}
          </pre>
        </div>
      ))}
    </div>
  );
};
