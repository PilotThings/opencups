import { useState } from 'react';
import { Layout, LayoutContent, VStack, HStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Spinner } from '@astryxdesign/core/Spinner';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { TextArea } from '@astryxdesign/core/TextArea';
import { FileInput } from '@astryxdesign/core/FileInput';
import { dateTime, expiryBadge } from '../format.js';

export function Page({ title, subtitle, actions, children, maxWidth = 1200 }) {
  return (
    <Layout
      height="fill"
      contentWidth={maxWidth}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6}>
            <HStack hAlign="between" vAlign="center" gap={4} wrap="wrap">
              <VStack gap={1}>
                <Heading level={1}>{title}</Heading>
                {subtitle && <Text color="secondary">{subtitle}</Text>}
              </VStack>
              {actions && <HStack gap={2} wrap="wrap">{actions}</HStack>}
            </HStack>
            {children}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

export function Loading() {
  return (
    <HStack gap={2} vAlign="center" padding={4}>
      <Spinner size="lg" />
      <Text color="secondary">Loading…</Text>
    </HStack>
  );
}

export function ErrorBanner({ error }) {
  if (!error) return null;
  return <Banner status="error" title="Something went wrong" description={error} />;
}

export function StatTile({ label, value, hint, tone }) {
  return (
    <Card>
      <VStack gap={2}>
        <Text type="label" color="secondary">{label}</Text>
        <HStack gap={2} vAlign="center">
          <Heading level={2}>{value ?? '—'}</Heading>
          {tone && <Badge variant={tone.variant} label={tone.label} />}
        </HStack>
        {hint && <Text type="supporting">{hint}</Text>}
      </VStack>
    </Card>
  );
}

export function Mono({ children }) {
  return <span className="mono">{children}</span>;
}

/** Summary of a certificate as returned by the API (certInfo). */
export function CertDetails({ cert, extra }) {
  if (!cert) return <Text color="secondary">None</Text>;
  const exp = expiryBadge(cert.daysLeft);
  return (
    <MetadataList label={{ width: 140 }}>
      <MetadataListItem label="Subject"><Mono>{cert.subject}</Mono></MetadataListItem>
      <MetadataListItem label="Issuer"><Mono>{cert.issuer}</Mono></MetadataListItem>
      <MetadataListItem label="Valid from">{dateTime(cert.notBefore)}</MetadataListItem>
      <MetadataListItem label="Valid until">
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text>{dateTime(cert.notAfter)}</Text>
          <Badge variant={exp.variant} label={exp.label} />
        </HStack>
      </MetadataListItem>
      <MetadataListItem label="Key">{cert.keyType}</MetadataListItem>
      {cert.subjectAltName && <MetadataListItem label="SAN"><Mono>{cert.subjectAltName}</Mono></MetadataListItem>}
      <MetadataListItem label="SHA-256"><Mono>{cert.fingerprint256}</Mono></MetadataListItem>
      {extra}
    </MetadataList>
  );
}

/** PEM text field with an "upload file" shortcut that fills it. */
export function PemField({ label, value, onChange, description, isOptional, placeholder = '-----BEGIN …-----' }) {
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const pick = async (f) => {
    setFile(f);
    setFileError(null);
    if (!f) return;
    try {
      const text = await f.text();
      if (!text.includes('-----BEGIN')) throw new Error('File does not contain PEM data');
      onChange(text);
    } catch (e) {
      setFileError(e.message);
    }
  };
  return (
    <VStack gap={2}>
      <TextArea
        label={label}
        description={description}
        isOptional={isOptional}
        value={value}
        onChange={onChange}
        rows={4}
        placeholder={placeholder}
        hasSpellCheck={false}
        status={fileError ? { type: 'error', message: fileError } : undefined}
      />
      <FileInput label={`Upload ${label.toLowerCase()} file`} isLabelHidden value={file} onChange={pick} accept=".pem,.crt,.cer,.key,.trust,.txt" placeholder="…or choose a PEM file" />
    </VStack>
  );
}
