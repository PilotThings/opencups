import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { AppShell } from '@astryxdesign/core/AppShell';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { HomeIcon, ServerStackIcon, Cog6ToothIcon, SignalIcon } from '@heroicons/react/24/outline';
import {
  HomeIcon as HomeSolid,
  ServerStackIcon as ServerStackSolid,
  Cog6ToothIcon as CogSolid,
} from '@heroicons/react/24/solid';
import { getToken, onUnauthorized, setToken } from './api.js';
import Home from './pages/Home.jsx';
import Gateways from './pages/Gateways.jsx';
import GatewayDetail from './pages/GatewayDetail.jsx';
import Setup from './pages/Setup.jsx';

function Nav() {
  const { pathname } = useLocation();
  const is = (p) => (p === '/' ? pathname === '/' : pathname.startsWith(p));
  return (
    <SideNav
      header={<SideNavHeading heading="OpenCUPS" subheading="Basics Station CUPS" icon={<SignalIcon width={20} />} headingHref="/" />}>
      <SideNavSection title="Navigation" isHeaderHidden>
        <SideNavItem label="Home" href="/" icon={HomeIcon} selectedIcon={HomeSolid} isSelected={is('/')} />
        <SideNavItem label="Gateways" href="/gateways" icon={ServerStackIcon} selectedIcon={ServerStackSolid} isSelected={is('/gateways')} />
        <SideNavItem label="Setup" href="/setup" icon={Cog6ToothIcon} selectedIcon={CogSolid} isSelected={is('/setup')} />
      </SideNavSection>
    </SideNav>
  );
}

function TokenDialog() {
  const [isOpen, setOpen] = useState(false);
  const [value, setValue] = useState(getToken());
  useEffect(() => onUnauthorized(() => setOpen(true)), []);
  const save = () => {
    setToken(value.trim());
    window.location.reload();
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={setOpen} purpose="required" width={440}>
      <DialogHeader title="Admin token required" subtitle="This server has ADMIN_TOKEN set." />
      <VStack gap={4} padding={4}>
        <Text>Enter the admin token to use the management API. It is kept in this browser only.</Text>
        <TextInput label="Admin token" type="password" value={value} onChange={setValue} onEnter={save} hasAutoFocus />
        <HStack hAlign="end">
          <Button label="Continue" variant="primary" onClick={save} isDisabled={!value.trim()} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

export default function App() {
  return (
    <AppShell sideNav={<Nav />} height="fill">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/gateways" element={<Gateways />} />
        <Route path="/gateways/:eui" element={<GatewayDetail />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <TokenDialog />
    </AppShell>
  );
}
