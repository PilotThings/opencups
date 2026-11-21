import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Icon } from '@astryxdesign/core/Icon';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowPathIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { StopIcon } from '@heroicons/react/24/solid';
import { useApi } from '../hooks.js';
import { api, downloadText } from '../api.js';
import { CertDetails, ErrorBanner, Loading, Page, StatTile } from '../components/common.jsx';
import { dateTime } from '../format.js';

const COLORS = {
  valid: 'var(--color-data-categorical-blue, #0171E3)',
  invalid: 'var(--color-data-categorical-orange, #EB6E00)',
};
const tick = { fontSize: 'var(--font-size-sm, 12px)', fill: 'var(--color-text-secondary, #4E606F)' };
const shortDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function LegendItem({ color, label }) {
  return (
    <HStack gap={2} vAlign="center">
      <Icon icon={StopIcon} size="xsm" style={{ color }} />
      <Text type="supporting" color="secondary">{label}</Text>
    </HStack>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <Card padding={3} elevation="med">
      <VStack gap={1}>
        <Text type="supporting" color="secondary">{shortDate(label)}</Text>
        {payload.map((p) => (
          <HStack key={p.dataKey} gap={2} vAlign="center">
            <Icon icon={StopIcon} size="xsm" style={{ color: p.color }} />
            <Text type="supporting">{p.name}: {p.value}</Text>
          </HStack>
        ))}
      </VStack>
    </Card>
  );
}

function RequestsChart({ data }) {
  const total = data.reduce((s, d) => s + d.valid + d.invalid, 0);
  return (
    <Card>
      <VStack gap={4}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={1}>
            <Heading level={3}>CUPS requests</Heading>
            <Text type="supporting">Last 30 days · {total.toLocaleString()} requests</Text>
          </VStack>
          <HStack gap={4}>
            <LegendItem color={COLORS.valid} label="Valid" />
            <LegendItem color={COLORS.invalid} label="Invalid" />
          </HStack>
        </HStack>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border, rgba(5,54,89,0.1))" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={tick} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} width={36} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-background-muted, rgba(5,54,89,0.05))' }} />
            <Bar dataKey="valid" name="Valid" stackId="r" fill={COLORS.valid} isAnimationActive={false} />
            <Bar dataKey="invalid" name="Invalid" stackId="r" fill={COLORS.invalid} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </VStack>
    </Card>
  );
}

export default function Home() {
  const status = useApi('/status', { interval: 15000 });
  const stats = useApi('/stats/requests?days=30', { interval: 60000 });
  const s = status.data;

  const downloadCa = async () => {
    const setup = await api('/setup');
    downloadText('cups.trust', setup.ca.certPem);
  };

  return (
    <Page
      title="Overview"
      subtitle="Status of the CUPS server and the gateways it manages"
      actions={<Button label="Refresh" icon={<Icon icon={ArrowPathIcon} />} onClick={() => { status.reload(); stats.reload(); }} />}>
      <ErrorBanner error={status.error} />
      {!s ? <Loading /> : (
        <>
          {!s.ca && (
            <Banner status="warning" title="No CUPS CA configured" description="The CUPS endpoint starts as soon as a CA is configured."
              endContent={<Button label="Go to setup" href="/setup" variant="primary" size="sm" />} />
          )}

          <Grid columns={{ minWidth: 220, repeat: 'fit' }} gap={4}>
            <StatTile label="Gateways" value={s.counts.gateways} hint={`${s.counts.activeGateways} with valid requests in 30 days`} />
            <StatTile label="Certificates invalid within 30 days" value={s.counts.certsExpiringSoon}
              hint={s.counts.certsExpired ? `${s.counts.certsExpired} already expired` : 'Gateway CUPS and LNS certificates'}
              tone={s.counts.certsExpiringSoon ? { variant: 'warning', label: 'Action needed' } : undefined} />
            <StatTile label="Invalid CUPS requests (30 days)" value={s.counts.invalidRequests30d}
              hint={`of ${s.counts.requests30d.toLocaleString()} requests`}
              tone={s.counts.invalidRequests30d ? { variant: 'error', label: 'Check' } : undefined} />
          </Grid>

          <Grid columns={{ minWidth: 380, repeat: 'fit' }} gap={4}>
            <Card>
              <VStack gap={4}>
                <HStack hAlign="between" vAlign="center">
                  <Heading level={3}>CUPS server</Heading>
                  <Badge variant={s.cups.running ? 'success' : 'error'} label={s.cups.running ? 'Running' : 'Stopped'} />
                </HStack>
                {s.cups.error && <Text color="secondary">{s.cups.error}</Text>}
                <VStack gap={2}>
                  <Text type="label">URL for gateways (cups.uri)</Text>
                  <CodeBlock code={s.cups.url} width="100%" />
                </VStack>
                <MetadataList label={{ width: 150 }}>
                  <MetadataListItem label="Endpoint">{s.cups.endpoint}</MetadataListItem>
                  <MetadataListItem label="Listening port">{s.cups.port}</MetadataListItem>
                  <MetadataListItem label="Client auth">{s.cups.requireClientCert ? 'Client certificate required' : 'Optional'}</MetadataListItem>
                  <MetadataListItem label="LNS URL">{s.lnsUrl || 'Not configured'}</MetadataListItem>
                  <MetadataListItem label="Started">{dateTime(s.cups.startedAt)}</MetadataListItem>
                </MetadataList>
              </VStack>
            </Card>

            <Card>
              <VStack gap={4}>
                <HStack hAlign="between" vAlign="center">
                  <Heading level={3}>CA certificate</Heading>
                  {s.ca && <Badge variant="neutral" label={s.ca.source === 'uploaded' ? 'Uploaded' : 'Self-signed'} />}
                </HStack>
                {s.ca ? (
                  <>
                    <CertDetails cert={s.ca} />
                    <HStack>
                      <Button label="Download cups.trust" size="sm" icon={<Icon icon={ArrowDownTrayIcon} />} onClick={downloadCa} />
                    </HStack>
                  </>
                ) : <Text color="secondary">Not configured</Text>}
              </VStack>
            </Card>
          </Grid>

          <ErrorBanner error={stats.error} />
          {stats.data && <RequestsChart data={stats.data} />}
        </>
      )}
    </Page>
  );
}
