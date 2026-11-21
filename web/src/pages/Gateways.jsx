import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Link } from '@astryxdesign/core/Link';
import { Icon } from '@astryxdesign/core/Icon';
import { TextInput } from '@astryxdesign/core/TextInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { PlusIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { useApi } from '../hooks.js';
import { ErrorBanner, Loading, Mono, Page } from '../components/common.jsx';
import { GatewayForm } from '../components/GatewayForm.jsx';
import { dateTime, expiryBadge, relativeTime } from '../format.js';

const columns = [
  {
    key: 'name',
    header: 'Gateway',
    width: proportional(2),
    renderCell: (g) => (
      <VStack gap={0.5}>
        <Link href={`/gateways/${g.eui}`}>{g.name || g.euiFormatted}</Link>
        <Text type="supporting"><Mono>{g.euiFormatted}</Mono></Text>
      </VStack>
    ),
  },
  {
    key: 'lastSeenAt',
    header: 'Last CUPS request',
    width: proportional(2),
    renderCell: (g) =>
      g.lastSeenAt ? (
        <VStack gap={0.5}>
          <HStack gap={2} vAlign="center">
            <Text>{relativeTime(g.lastSeenAt)}</Text>
            <Badge variant={g.lastValid ? 'success' : 'error'} label={g.lastValid ? 'OK' : 'Rejected'} />
          </HStack>
          <Text type="supporting" maxLines={1}>{dateTime(g.lastSeenAt)} · {g.lastReason}</Text>
        </VStack>
      ) : <Text color="secondary">Never</Text>,
  },
  {
    key: 'lastPackage',
    header: 'Station',
    width: pixel(130),
    renderCell: (g) => (g.lastPackage ? <Text>{g.lastPackage}{g.lastModel ? ` · ${g.lastModel}` : ''}</Text> : <Text color="secondary">—</Text>),
  },
  {
    key: 'tcAuth',
    header: 'LNS auth',
    width: pixel(120),
    renderCell: (g) => <Badge variant="neutral" label={{ certificate: 'Certificate', token: 'Token', none: 'None' }[g.tcAuth]} />,
  },
  {
    key: 'nextExpiry',
    header: 'Certificate validity',
    width: pixel(190),
    renderCell: (g) => {
      const b = expiryBadge(g.daysToExpiry);
      return (
        <VStack gap={0.5}>
          <Badge variant={b.variant} label={b.label} />
          {g.nextExpiry && <Text type="supporting">until {new Date(g.nextExpiry).toLocaleDateString()}</Text>}
        </VStack>
      );
    },
  },
];

export default function Gateways() {
  const { data, error, reload } = useApi('/gateways', { interval: 30000 });
  const [q, setQ] = useState('');
  const [isAdding, setAdding] = useState(() => window.location.hash === '#add'); // deep link: /gateways#add
  const navigate = useNavigate();

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/[-:]/g, '');
    if (!data) return [];
    if (!s) return data;
    return data.filter((g) => g.name.toLowerCase().includes(s) || g.eui.toLowerCase().includes(s));
  }, [data, q]);

  return (
    <Page
      title="Gateways"
      subtitle="Gateways provisioned on this CUPS server"
      actions={<Button label="Add gateway" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={() => setAdding(true)} />}>
      <ErrorBanner error={error} />
      {!data ? <Loading /> : data.length === 0 ? (
        <Card>
          <EmptyState title="No gateways yet" description="Add a gateway with its LNS credentials; it receives them on its next CUPS request."
            actions={<Button label="Add gateway" variant="primary" onClick={() => setAdding(true)} />} />
        </Card>
      ) : (
        <Card padding={0}>
          <VStack gap={0}>
            <HStack padding={4} gap={2} vAlign="center" hAlign="between" wrap="wrap">
              <TextInput label="Search gateways" isLabelHidden value={q} onChange={setQ} startIcon={MagnifyingGlassIcon} placeholder="Search by name or EUI" hasClear width={320} />
              <Text type="supporting">{rows.length} of {data.length} gateways</Text>
            </HStack>
            <Table data={rows} columns={columns} idKey="eui" density="balanced" dividers="rows" hasHover verticalAlign="top" />
          </VStack>
        </Card>
      )}
      <GatewayForm isOpen={isAdding} onOpenChange={setAdding} onSaved={(g) => { reload(); navigate(`/gateways/${g.eui}`); }} />
    </Page>
  );
}
