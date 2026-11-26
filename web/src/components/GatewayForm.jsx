import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Divider } from '@astryxdesign/core/Divider';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { api } from '../api.js';
import { Selector } from '@astryxdesign/core/Selector';
import { PemField } from './common.jsx';
import { dateTime } from '../format.js';

const empty = {
  eui: '', name: '', description: '', tcUri: '', cupsUri: '',
  tcAuth: 'certificate', tcTrustPem: '', tcCertPem: '', tcKeyPem: '', tcToken: '',
  cupsMode: 'generate', cupsCertPem: '', cupsKeyPem: '', generateBootCert: true,
};

/**
 * Create (gateway == null) or edit a gateway.
 * In edit mode, credential fields left empty keep their current value.
 */
export function GatewayForm({ isOpen, onOpenChange, gateway, onSaved }) {
  const isEdit = Boolean(gateway);
  const [f, setF] = useState(empty);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // null while checking setup; otherwise configuration and gateway list status.
  const [cs, setCs] = useState(null);
  const [source, setSource] = useState('manual');
  const [selectedGateway, setSelectedGateway] = useState('');
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSource('manual');
    setSelectedGateway('');
    setF(gateway ? {
      ...empty,
      eui: gateway.euiFormatted,
      name: gateway.name,
      description: gateway.description,
      tcUri: gateway.tcUri || '',
      cupsUri: gateway.cupsUri || '',
      tcAuth: gateway.tcAuth === 'none' ? 'none' : gateway.tcAuth,
      cupsMode: 'keep',
    } : empty);
  }, [isOpen, gateway]);

  useEffect(() => {
    setCs(null);
    if (!isOpen) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const setup = await api('/setup');
        if (cancelled) return;
        if (!setup.chirpstack) {
          setCs({ configured: false, gateways: [], error: null });
          return;
        }
        if (gateway) {
          setCs({ configured: true, gateways: [], error: null });
          return;
        }
        setCs({ configured: true, gateways: null, error: null });
        const gateways = await api('/chirpstack/gateways');
        if (!cancelled) setCs({ configured: true, gateways, error: null });
      } catch (e) {
        if (!cancelled) setCs((c) => ({ configured: c?.configured || false, gateways: [], error: e.message }));
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, gateway]);

  const pickChirpStack = (eui) => {
    const g = cs?.gateways?.find((x) => x.eui === eui);
    setSelectedGateway(eui);
    setF((s) => (g ? { ...s, eui: g.eui, name: g.name || '', description: g.description || '', tcAuth: 'chirpstack' } : { ...s, eui: '' }));
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const body = { name: f.name, description: f.description, tcUri: f.tcUri, cupsUri: f.cupsUri };
    if (!isEdit) body.eui = f.eui;
    if (f.tcTrustPem.trim()) body.tcTrustPem = f.tcTrustPem;
    if (f.tcAuth === 'chirpstack') {
      body.generateChirpStackCert = true;
    } else if (f.tcAuth === 'certificate') {
      if (f.tcCertPem.trim() || f.tcKeyPem.trim()) Object.assign(body, { tcCertPem: f.tcCertPem, tcKeyPem: f.tcKeyPem });
      if (isEdit && gateway.tcAuth === 'token') body.tcToken = '';
    } else if (f.tcAuth === 'token') {
      if (f.tcToken.trim()) body.tcToken = f.tcToken;
      if (isEdit && gateway.tcAuth === 'certificate') Object.assign(body, { tcCertPem: '', tcKeyPem: '' });
    } else {
      Object.assign(body, { tcCertPem: '', tcKeyPem: '', tcToken: '' });
    }
    if (f.cupsMode === 'provide') Object.assign(body, { cupsCertPem: f.cupsCertPem, cupsKeyPem: f.cupsKeyPem });
    if (!isEdit && f.cupsMode === 'none') body.generateCupsCert = false;
    if (!isEdit && f.generateBootCert) body.generateBootCert = true;
    try {
      const saved = isEdit
        ? await api(`/gateways/${gateway.eui}`, { method: 'PATCH', body })
        : await api('/gateways', { method: 'POST', body });
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const keepHint = isEdit ? 'Leave empty to keep the current value.' : undefined;
  const chirpStackSelected = !isEdit && source === 'chirpstack' && Boolean(selectedGateway);

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={640} maxHeight="90dvh">
      <DialogHeader title={isEdit ? `Edit ${gateway.name || gateway.euiFormatted}` : 'Add gateway'} onOpenChange={onOpenChange} />
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
      <VStack gap={5} padding={5}>
        {error && <Banner status="error" title="Could not save gateway" description={error} />}

        <VStack gap={3}>
          {!isEdit && (
            <VStack gap={2}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                <Text type="label">Gateway source</Text>
                <SegmentedControl aria-label="Gateway source" value={source} onChange={(value) => { setSource(value); setSelectedGateway(''); }}>
                  <SegmentedControlItem value="manual" label="Manual" />
                  <SegmentedControlItem value="chirpstack" label="From ChirpStack" isDisabled={!cs?.configured} />
                </SegmentedControl>
              </div>
              {!cs && <Text type="supporting">Checking ChirpStack integration…</Text>}
              {cs && !cs.configured && !cs.error && <Text type="supporting">Configure the ChirpStack integration in Setup to select a gateway from ChirpStack.</Text>}
              {cs?.error && <Banner status="warning" title={cs.configured ? 'Could not load ChirpStack gateways' : 'Could not check ChirpStack integration'} description={cs.error} />}
              {source === 'chirpstack' && <Selector label="ChirpStack gateway" value={selectedGateway} onChange={pickChirpStack}
                isDisabled={!cs.gateways?.length}
                description={cs.gateways === null ? 'Loading…' : cs.gateways.length
                  ? 'Select a gateway to fill in its read-only EUI, name, and description.'
                  : cs.error ? 'Choose Manual to enter a gateway instead.' : 'All ChirpStack gateways of this tenant are already in OpenCUPS.'}
                options={[{ value: '', label: 'Select a gateway' }, ...(cs.gateways || []).map((g) => ({
                  value: g.eui, label: `${g.name || g.gatewayId} · ${g.gatewayId}${g.lastSeenAt ? ` · seen ${dateTime(g.lastSeenAt)}` : ''}`,
                }))]} />}
            </VStack>
          )}
          <TextInput label="Gateway EUI" value={f.eui} onChange={set('eui')} isDisabled={isEdit} isReadOnly={chirpStackSelected}
            description="EUI-64 (B8-27-EB-FF-FE-61-51-B5) or Station id6 (b827:ebff:fe61:51b5)" placeholder="B8-27-EB-FF-FE-61-51-B5" />
          <TextInput label="Name" value={f.name} onChange={set('name')} placeholder="Rooftop gateway" isReadOnly={chirpStackSelected} />
          <TextInput label="Description" value={f.description} onChange={set('description')} isOptional isReadOnly={chirpStackSelected} />
        </VStack>

        <Divider />
        <VStack gap={3}>
          <Heading level={4}>LNS connection</Heading>
          <TextInput label="LNS URI override" value={f.tcUri} onChange={set('tcUri')} isOptional
            description="Leave empty to use the LNS URL from Setup." placeholder="wss://lns.example.com:8887" />
          <PemField label="LNS trust (CA certificate)" value={f.tcTrustPem} onChange={set('tcTrustPem')} isOptional
            description={keepHint || 'Leave empty to use the default LNS trust from Setup.'} />
          <VStack gap={2}>
            <Text type="label">LNS client authentication</Text>
            <SegmentedControl value={f.tcAuth} onChange={set('tcAuth')}>
              <SegmentedControlItem value="certificate" label="Client certificate" />
              <SegmentedControlItem value="chirpstack" label="From ChirpStack" isDisabled={!cs?.configured} />
              <SegmentedControlItem value="token" label="Auth token" />
              <SegmentedControlItem value="none" label="None" />
            </SegmentedControl>
          </VStack>
          {f.tcAuth === 'chirpstack' && <Text type="supporting">ChirpStack will generate a client certificate and private key when you save. The gateway must exist in the configured tenant, and ChirpStack must have a gateway CA configured.</Text>}
          {f.tcAuth === 'certificate' && (
            <>
              <PemField label="LNS client certificate" value={f.tcCertPem} onChange={set('tcCertPem')} description={keepHint} />
              <PemField label="LNS client private key" value={f.tcKeyPem} onChange={set('tcKeyPem')} description={keepHint} placeholder="-----BEGIN EC PRIVATE KEY-----" />
            </>
          )}
          {f.tcAuth === 'token' && (
            <TextInput label="Auth header" type="password" value={f.tcToken} onChange={set('tcToken')}
              description={keepHint || 'Full HTTP header line sent to the LNS, e.g. "Authorization: Bearer NNSXS…"'} />
          )}
        </VStack>

        <Divider />
        <VStack gap={3}>
          <Heading level={4}>CUPS client certificate</Heading>
          <SegmentedControl value={f.cupsMode} onChange={set('cupsMode')}>
            {isEdit && <SegmentedControlItem value="keep" label="Keep current" />}
            {!isEdit && <SegmentedControlItem value="generate" label="Generate from CA" />}
            <SegmentedControlItem value="provide" label="Provide certificate" />
            {!isEdit && <SegmentedControlItem value="none" label="None" />}
          </SegmentedControl>
          {f.cupsMode === 'generate' && <Text type="supporting">A client certificate with CN = gateway EUI is issued by the CUPS CA.</Text>}
          {f.cupsMode === 'none' && <Text type="supporting">Only works when Setup does not require client certificates.</Text>}
          {f.cupsMode === 'provide' && (
            <>
              <PemField label="CUPS client certificate" value={f.cupsCertPem} onChange={set('cupsCertPem')} description="Must be signed by the CUPS CA." />
              <PemField label="CUPS client private key" value={f.cupsKeyPem} onChange={set('cupsKeyPem')} placeholder="-----BEGIN EC PRIVATE KEY-----" />
            </>
          )}
          {!isEdit && (
            <CheckboxInput label="Also issue bootstrap credentials (cups-boot.*)" value={f.generateBootCert} onChange={set('generateBootCert')}
              description="Long-lived fallback set baked into the gateway image; lets Station recover when its regular and backup credentials fail." />
          )}
        </VStack>

        <HStack hAlign="end" gap={2}>
          <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
          <Button label={isEdit ? 'Save changes' : 'Add gateway'} variant="primary" onClick={submit} isLoading={saving}
            isDisabled={saving || (!isEdit && (!f.eui.trim() || (source === 'chirpstack' && !selectedGateway)))} />
        </HStack>
      </VStack>
      </div>
    </Dialog>
  );
}
