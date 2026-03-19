"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface EnterpriseFeatureCardProps {
  feature: string;
  description: string;
}

export function EnterpriseFeatureCard({ feature, description }: EnterpriseFeatureCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {feature}
          <span className="text-xs font-normal bg-primary/10 text-primary px-2 py-0.5 rounded-full">
            Enterprise
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground">{description}</p>
        <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
          <p className="text-sm font-medium">How to enable</p>
          <p className="text-sm text-muted-foreground">
            Set your license key in{" "}
            <a href="/settings?tab=license" className="text-primary underline">
              Settings → License
            </a>
            , or via the{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">PINCHY_ENTERPRISE_KEY</code>{" "}
            environment variable.
          </p>
          <a
            href="https://heypinchy.com/enterprise?utm_source=app&utm_medium=feature-card"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="mt-2">
              Learn more
            </Button>
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
