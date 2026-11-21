import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { useToast } from '@astryxdesign/core/Toast';
import { ArrowDownTrayIcon, ArrowPathIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useApi } from '../hooks.js';
import { api, downloadText } from '../api.js';
import { CertDetails, ErrorBanner, Loading, Mono, Page } from '../components/common.jsx';
import { GatewayForm } from '../components/GatewayForm.jsx';
import { dateTime, hex32, relativeTime } from '../format.js';

const requestColumns = [
  { key: 'ts', header: 'Time', width: pixel(190), renderCell: (r) => dateTime(r.ts) },
  { key: 'valid', header: 'Result', width: pixel(110), renderCell: (r) => <Badge variant={r.valid ? 'success' : 'error'} label={`${r.statusCode || 'TLS'} ${r.valid ? 'OK' : 'Rejected'}`} /> },
  {
    key: 'reason', header: 'Details', width: proportional(1),
    renderCell: (r) => (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text>{r.reason || '—'}</Text>
        {r.credSet && r.credSet !== 'regular' && <Badge variant="warning" label={`${r.credSet} cert`} />}
      </HStack>
    ),
  },
  { key: 'package', header: 'Station', width: pixel(110), renderCell: (r) => r.request?.package || '—' },
  { key: 'remoteAddr', header: 'From', width: pixel(160), renderCell: (r) => <Mono>{r.remoteAddr}</Mono> },
];

export default function GatewayDetail() {
  const { eui } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const gw = useApi(`/gateways/${eui}`, { interval: 30000 });
  const reqs = useApi(`/requests?gateway=${eui}&limit=25`, { interval: 30000 });
  const [isEditing, setEditing] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const [isRenewing, setRenewing] = useState(false);
  const g = gw.data;

  const remove = async () => {
    try {
      await api(`/gateways/${eui}`, { method: 'DELETE' });
      toast({ body: `Gateway ${g.euiFormatted} removed` });
      navigate('/gateways');
    } catch (e) {
      toast({ body: e.message, type: 'error' });
    }
  };

  const renew = async () => {
    try {
      gw.setData(await api(`/gateways/${eui}/cups-cert/renew`, { method: 'POST' }));
      toast({ body: 'New CUPS client certificate issued. Download the bootstrap files for the gateway.' });
    } catch (e) {
      toast({ body: e.message, type: 'error' });
    } finally {
      setRenewing(false);
    }
  };

  const issueBoot = async () => {
    try {
      gw.setData(await api(`/gateways/${eui}/boot-cert`, { method: 'POST' }));
      toast({ body: 'Bootstrap certificate issued. Bake the cups-boot.* files into the gateway image.' });
    } catch (e) {
      toast({ body: e.message, type: 'error' });
    }
  };

  const downloadBootstrap = async () => {
    try {
      const files = await api(`/gateways/${eui}/bootstrap`);
      for (const [name, text] of Object.entries(files)) downloadText(name, text);
    } catch (e) {
      toast({ body: e.message, type: 'error' });
    }
  };

  if (!g) {
    return <Page title="Gateway">{gw.error ? <ErrorBanner error={gw.error} /> : <Loading />}</Page>;
  }

  return (
    <Page
      title={g.name || g.euiFormatted}
      subtitle={<Mono>{g.euiFormatted}</Mono>}
      actions={
        <>
          <Button label="Provisioning files" icon={<Icon icon={ArrowDownTrayIcon} />} onClick={downloadBootstrap}
            tooltip="Download cups.{uri,trust,crt,key} (and cups-boot.* if issued) for the Station home directory" />
          <Button label="Edit" icon={<Icon icon={PencilSquareIcon} />} onClick={() => setEditing(true)} />
          <Button label="Remove" variant="destructive" icon={<Icon icon={TrashIcon} />} onClick={() => setDeleting(true)} />
        </>
      }>
      <Breadcrumbs>
        <BreadcrumbItem href="/gateways">Gateways</BreadcrumbItem>
        <BreadcrumbItem isCurrent>{g.name || g.euiFormatted}</BreadcrumbItem>
      </Breadcrumbs>
      <ErrorBanner error={gw.error} />

      <Grid columns={{ minWidth: 380, repeat: 'fit' }} gap={4}>
        <Card>
          <VStack gap={4}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={3}>Last CUPS request</Heading>
              {g.lastSeenAt && <Badge variant={g.lastValid ? 'success' : 'error'} label={g.lastValid ? 'OK' : 'Rejected'} />}
            </HStack>
            <MetadataList label={{ width: 150 }}>
              <MetadataListItem label="When">{g.lastSeenAt ? `${relativeTime(g.lastSeenAt)} (${dateTime(g.lastSeenAt)})` : 'Never'}</MetadataListItem>
              <MetadataListItem label="Result">{g.lastReason || '—'}</MetadataListItem>
              <MetadataListItem label="From"><Mono>{g.lastRemoteAddr || '—'}</Mono></MetadataListItem>
              <MetadataListItem label="Station package">{g.lastPackage || '—'}</MetadataListItem>
              <MetadataListItem label="Model">{g.lastModel || '—'}</MetadataListItem>
              <MetadataListItem label="Station">{g.lastStation || '—'}</MetadataListItem>
            </MetadataList>
          </VStack>
        </Card>

        <Card>
          <VStack gap={4}>
            <Heading level={3}>Configuration served</Heading>
            <MetadataList label={{ width: 150 }}>
              <MetadataListItem label="CUPS URI">{g.effective.cupsUri}{g.cupsUri ? ' (override)' : ''}</MetadataListItem>
              <MetadataListItem label="LNS URI">{g.effective.tcUri || 'Not configured'}{g.tcUri ? ' (override)' : ''}</MetadataListItem>
              <MetadataListItem label="LNS auth">{{ certificate: 'Client certificate', token: 'Auth token', none: 'None (server auth only)' }[g.tcAuth]}</MetadataListItem>
              <MetadataListItem label="LNS trust from">{{ gateway: 'This gateway', setup: 'Setup default', none: 'None' }[g.effective.tcTrustSource]}</MetadataListItem>
              <MetadataListItem label="CUPS cred CRC"><Mono>{hex32(g.effective.cupsCredCrc)}</Mono></MetadataListItem>
              <MetadataListItem label="LNS cred CRC"><Mono>{hex32(g.effective.tcCredCrc)}</Mono></MetadataListItem>
              {g.description && <MetadataListItem label="Description">{g.description}</MetadataListItem>}
              <MetadataListItem label="Created">{dateTime(g.createdAt)}</MetadataListItem>
            </MetadataList>
          </VStack>
        </Card>

        <Card>
          <VStack gap={4}>
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
              <Heading level={3}>CUPS client certificate</Heading>
              <HStack gap={2} vAlign="center">
                {g.cupsCert && <Badge variant="neutral" label={g.cupsCert.generated ? 'Issued by CUPS CA' : 'Provided'} />}
                <Button label="Renew" size="sm" icon={<Icon icon={ArrowPathIcon} />} onClick={() => setRenewing(true)} />
              </HStack>
            </HStack>
            {g.cupsCertRotationPending && (
              <Text type="supporting">Rotation pending: the previous certificate stays accepted until the gateway connects with this one.</Text>
            )}
            <CertDetails cert={g.cupsCert} />
          </VStack>
        </Card>

        <Card>
          <VStack gap={4}>
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
              <VStack gap={1}>
                <Heading level={3}>Bootstrap credentials</Heading>
                <Text type="supporting">Station cups-boot.* — immutable on the device, used when regular and backup credentials fail. Always accepted.</Text>
              </VStack>
              <Button label={g.bootCert ? 'Re-issue' : 'Issue'} size="sm" icon={<Icon icon={ArrowPathIcon} />} onClick={issueBoot} />
            </HStack>
            {g.bootCert
              ? <CertDetails cert={g.bootCert} />
              : <Text color="secondary">None. Without bootstrap credentials, a gateway whose regular and backup credentials both fail needs manual re-provisioning.</Text>}
          </VStack>
        </Card>

        <Card>
          <VStack gap={4}>
            <Heading level={3}>LNS credentials</Heading>
            <VStack gap={2}>
              <Text type="label">Client certificate</Text>
              {g.tcCert ? <CertDetails cert={g.tcCert} /> : <Text color="secondary">{g.hasTcToken ? 'Uses an auth token instead' : 'None'}</Text>}
            </VStack>
            <VStack gap={2}>
              <Text type="label">Trust (LNS CA)</Text>
              {g.tcTrust ? <CertDetails cert={g.tcTrust} /> : <Text color="secondary">{g.effective.tcTrustSource === 'setup' ? 'Default LNS trust from Setup' : 'None'}</Text>}
            </VStack>
          </VStack>
        </Card>
      </Grid>

      <Card padding={0}>
        <VStack gap={0}>
          <HStack padding={4}><Heading level={3}>Recent CUPS requests</Heading></HStack>
          {reqs.data?.length
            ? <Table data={reqs.data} columns={requestColumns} idKey="id" density="compact" dividers="rows" />
            : <HStack padding={4}><Text color="secondary">No requests yet</Text></HStack>}
        </VStack>
      </Card>

      <GatewayForm isOpen={isEditing} onOpenChange={setEditing} gateway={g} onSaved={(saved) => gw.setData(saved)} />
      <AlertDialog isOpen={isDeleting} onOpenChange={setDeleting} title={`Remove ${g.name || g.euiFormatted}?`}
        description="The gateway will be rejected on its next CUPS request. Its credentials are deleted and cannot be recovered."
        actionLabel="Remove gateway" onAction={remove} />
      <AlertDialog isOpen={isRenewing} onOpenChange={setRenewing} title="Issue a new CUPS client certificate?"
        description="The new certificate is delivered to the gateway over CUPS on its next request; its current certificate stays accepted until the gateway has switched."
        actionLabel="Renew certificate" actionVariant="primary" onAction={renew} />
    </Page>
  );
}
