import { useEffect, useRef, useState } from 'react';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Divider } from '@astryxdesign/core/Divider';
import { TextInput } from '@astryxdesign/core/TextInput';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Selector } from '@astryxdesign/core/Selector';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { useToast } from '@astryxdesign/core/Toast';
import { useApi } from '../hooks.js';
import { api, downloadText } from '../api.js';
import { CertDetails, ErrorBanner, Loading, Mono, Page, PemField } from '../components/common.jsx';
import { dateTime } from '../format.js';

const SCROLL_MARGIN = { scrollMarginTop: 24 };

function CaSection({ setup, onChanged }) {
  const toast = useToast();
  const [mode, setMode] = useState('self-signed');
  const [cn, setCn] = useState('OpenCUPS Root CA');
  const [org, setOrg] = useState('OpenCUPS');
  const [days, setDays] = useState('3650');
  const [keyType, setKeyType] = useState('ec-p256');
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = mode === 'upload'
        ? await api('/setup/ca/upload', { method: 'POST', body: { certPem, keyPem } })
        : await api('/setup/ca/self-signed', { method: 'POST', body: { commonName: cn, organization: org, validityDays: Number(days), keyType } });
      onChanged(next);
      setCertPem('');
      setKeyPem('');
      toast({ body: 'CUPS CA updated and server certificate re-issued' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const submit = () => (setup.ca ? setConfirm(true) : apply());

  return (
    <Card>
      <VStack gap={5}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={1}>
            <Heading level={2}>CUPS CA certificate</Heading>
            <Text type="supporting">Signs the CUPS server certificate and the gateway client certificates. Gateways receive it as cups.trust.</Text>
          </VStack>
          {setup.ca && (
            <HStack gap={2}>
              <Badge variant="neutral" label={setup.ca.source === 'uploaded' ? 'Uploaded' : 'Self-signed'} />
              <Button label="Download" size="sm" onClick={() => downloadText('cups.trust', setup.ca.certPem)} />
            </HStack>
          )}
        </HStack>

        {setup.ca ? <CertDetails cert={setup.ca} /> : <Banner status="warning" title="No CA configured" description="The CUPS endpoint is stopped until a CA is configured." />}

        {setup.serverCert && (
          <VStack gap={2}>
            <Text type="label">CUPS server certificate (auto-issued)</Text>
            <MetadataList label={{ width: 140 }}>
              <MetadataListItem label="Hosts"><Mono>{setup.serverCert.hosts.join(', ')}</Mono></MetadataListItem>
              <MetadataListItem label="Valid until">{dateTime(setup.serverCert.notAfter)}</MetadataListItem>
              <MetadataListItem label="Issued">{dateTime(setup.serverCert.issuedAt)}</MetadataListItem>
            </MetadataList>
          </VStack>
        )}

        <Divider />
        <VStack gap={4}>
          <Heading level={3}>{setup.ca ? 'Replace CA' : 'Configure CA'}</Heading>
          <SegmentedControl value={mode} onChange={setMode}>
            <SegmentedControlItem value="self-signed" label="Generate self-signed" />
            <SegmentedControlItem value="upload" label="Upload certificate + key" />
          </SegmentedControl>
          {error && <Banner status="error" title="CA not changed" description={error} />}
          {mode === 'self-signed' ? (
            <VStack gap={3}>
              <TextInput label="Common name" value={cn} onChange={setCn} />
              <TextInput label="Organization" value={org} onChange={setOrg} isOptional />
              <HStack gap={3} wrap="wrap">
                <TextInput label="Validity (days)" value={days} onChange={setDays} inputMode="numeric" width={180} />
                <Selector label="Key type" value={keyType} onChange={setKeyType} width={220}
                  options={[{ value: 'ec-p256', label: 'ECDSA P-256' }, { value: 'rsa-2048', label: 'RSA 2048' }]} />
              </HStack>
            </VStack>
          ) : (
            <VStack gap={3}>
              <PemField label="CA certificate" value={certPem} onChange={setCertPem} description="Must be a CA certificate (basicConstraints CA:TRUE)." placeholder="-----BEGIN CERTIFICATE-----" />
              <PemField label="CA private key" value={keyPem} onChange={setKeyPem} description="Stored in the database; used to issue server and gateway certificates." placeholder="-----BEGIN EC PRIVATE KEY-----" />
            </VStack>
          )}
          <HStack>
            <Button label={mode === 'upload' ? 'Upload CA' : 'Generate CA'} variant="primary" onClick={submit} isLoading={busy}
              isDisabled={busy || (mode === 'upload' && (!certPem.trim() || !keyPem.trim()))} />
          </HStack>
        </VStack>
      </VStack>
      <AlertDialog isOpen={confirm} onOpenChange={setConfirm} title="Replace the CUPS CA?"
        description="The CUPS server certificate is re-issued from the new CA. Gateways that only trust the current CA can no longer connect and must be re-bootstrapped with new cups.trust/cups.crt/cups.key files (renew their CUPS certificate first)."
        actionLabel="Replace CA" onAction={apply} isActionLoading={busy} />
    </Card>
  );
}

function GeneralSection({ setup, onChanged }) {
  const toast = useToast();
  const [cupsUrl, setCupsUrl] = useState(setup.cupsPublicUrl);
  const [lnsUrl, setLnsUrl] = useState(setup.lnsUrl);
  const [lnsTrust, setLnsTrust] = useState(setup.lnsTrustPem);
  const [requireCert, setRequireCert] = useState(setup.requireClientCert);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCupsUrl(setup.cupsPublicUrl);
    setLnsUrl(setup.lnsUrl);
    setLnsTrust(setup.lnsTrustPem);
    setRequireCert(setup.requireClientCert);
  }, [setup]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api('/setup', { method: 'PUT', body: { cupsPublicUrl: cupsUrl, lnsUrl, lnsTrustPem: lnsTrust, requireClientCert: requireCert } }));
      toast({ body: 'Settings saved' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={2}>Endpoints</Heading>
          <Text type="supporting">What gateways are told to connect to. Per-gateway overrides are set on the gateway itself.</Text>
        </VStack>
        {error && <Banner status="error" title="Settings not saved" description={error} />}
        <TextInput label="CUPS public URL" value={cupsUrl} onChange={setCupsUrl} type="url"
          description="URL gateways use to reach this CUPS server (cups.uri). Its host name goes into the server certificate." placeholder="https://cups.example.com:6040" />
        <TextInput label="LNS URL" value={lnsUrl} onChange={setLnsUrl} type="url"
          description="LNS (tc.uri) handed to every gateway, e.g. wss://eu1.cloud.thethings.network:8887" placeholder="wss://lns.example.com:8887" />
        <PemField label="Default LNS trust" value={lnsTrust} onChange={setLnsTrust} isOptional
          description="CA certificate of the LNS (tc.trust) used for gateways without their own trust." placeholder="-----BEGIN CERTIFICATE-----" />
        {setup.lnsTrust && <Text type="supporting">Current: {setup.lnsTrust.subject} · valid until {dateTime(setup.lnsTrust.notAfter)}</Text>}
        <CheckboxInput label="Require gateway client certificate" value={requireCert} onChange={setRequireCert}
          description="Gateways must authenticate with a CUPS client certificate signed by the CUPS CA. Turning this off identifies gateways by EUI only." />
        <HStack>
          <Button label="Save settings" variant="primary" onClick={save} isLoading={busy} isDisabled={busy} />
        </HStack>
      </VStack>
    </Card>
  );
}

const NAV = [
  { id: 'setup-ca', label: 'CUPS CA certificate' },
  { id: 'setup-endpoints', label: 'Endpoints' },
];

function SetupNav({ items }) {
  const [active, setActive] = useState(items[0].id);
  const locked = useRef(false);
  const timer = useRef(null);
  const visible = useRef(new Set());

  const settle = () => {
    locked.current = false;
    const first = items.find((i) => visible.current.has(i.id));
    if (first) setActive(first.id);
  };
  // Hold the clicked highlight until smooth scrolling has stopped.
  const hold = (ms) => {
    locked.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, ms);
  };

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter(Boolean);
    if (!els.length || typeof IntersectionObserver === 'undefined') return undefined;
    const vis = visible.current;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? vis.add(e.target.id) : vis.delete(e.target.id)));
      if (locked.current) return;
      const first = items.find((i) => vis.has(i.id));
      if (first) setActive(first.id);
    }, { rootMargin: '0px 0px -60% 0px' });
    els.forEach((el) => obs.observe(el));
    const onScroll = () => { if (locked.current) hold(150); };
    document.addEventListener('scroll', onScroll, true);
    return () => {
      obs.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      clearTimeout(timer.current);
    };
  }, [items]);

  const go = (id) => {
    setActive(id);
    hold(600);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav aria-label="Setup sections" style={{ position: 'sticky', top: 0, alignSelf: 'flex-start', width: 220, flexShrink: 0 }}>
      <VStack gap={1}>
        {items.map((i) => (
          <div key={i.id}>
            <Button label={i.label} size="sm" width="100%" variant={active === i.id ? 'primary' : 'ghost'} onClick={() => go(i.id)} />
          </div>
        ))}
      </VStack>
    </nav>
  );
}

export default function Setup() {
  const { data, error, setData } = useApi('/setup');
  return (
    <Page title="Setup" subtitle="CUPS server CA and the LNS gateways are pointed to" maxWidth={1160}>
      <ErrorBanner error={error} />
      {!data ? <Loading /> : (
        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
          <SetupNav items={NAV} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <VStack gap={6}>
              <div id="setup-ca" style={SCROLL_MARGIN}><CaSection setup={data} onChanged={setData} /></div>
              <div id="setup-endpoints" style={SCROLL_MARGIN}><GeneralSection setup={data} onChanged={setData} /></div>
              {/* lets the last section scroll up to the top of the screen */}
              <div aria-hidden style={{ height: '70vh' }} />
            </VStack>
          </div>
        </div>
      )}
    </Page>
  );
}
