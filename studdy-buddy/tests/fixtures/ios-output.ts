/** Realistic Cisco IOS output samples used by the parser tests. */

export const SHOW_IP_INT_BRIEF_MIXED = `Router# show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     192.168.1.1     YES manual up                    up
GigabitEthernet0/1     unassigned      YES unset  administratively down down
GigabitEthernet0/2     10.0.0.1        YES manual down                  down
Serial0/0/0            203.0.113.1     YES manual up                    up`;

export const SHOW_RUNNING_CONFIG = `Building configuration...

Current configuration : 1204 bytes
!
version 15.1
hostname R1
!
interface GigabitEthernet0/0
 ip address 192.168.1.1 255.255.255.0
 no shutdown
!
interface GigabitEthernet0/1
 ip address 10.0.0.1 255.255.255.0
 shutdown
!
interface Vlan1
 no ip address
 shutdown
!
end`;

export const SHOW_VLAN_BRIEF = `VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/1, Fa0/2, Fa0/3, Fa0/4
10   STUDENTS                         active    Fa0/10, Fa0/11
20   TEACHERS                         active    Fa0/20
1002 fddi-default                     act/unsup
1003 token-ring-default               act/unsup`;

export const SHOW_IP_ROUTE_NO_DEFAULT = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP

Gateway of last resort is not set

      192.168.1.0/24 is variably subnetted, 2 subnets, 2 masks
C        192.168.1.0/24 is directly connected, GigabitEthernet0/0
L        192.168.1.1/32 is directly connected, GigabitEthernet0/0
      10.0.0.0/24 is variably subnetted, 2 subnets, 2 masks
C        10.0.0.0/24 is directly connected, GigabitEthernet0/1`;

export const SHOW_IP_ROUTE_WITH_DEFAULT = `Codes: L - local, C - connected, S - static

Gateway of last resort is 203.0.113.1 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 203.0.113.1
C        192.168.1.0/24 is directly connected, GigabitEthernet0/0`;

export const SHOW_MAC_TABLE = `          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
   1    0001.6455.2001    DYNAMIC     Fa0/1
   1    0002.17A3.4B5C    DYNAMIC     Fa0/2
  10    000C.85A1.1234    STATIC      Fa0/10`;

export const PING_SUCCESS = `PC> ping 192.168.1.20

Pinging 192.168.1.20 with 32 bytes of data:

Reply from 192.168.1.20: bytes=32 time=1ms TTL=128
Reply from 192.168.1.20: bytes=32 time<1ms TTL=128
Reply from 192.168.1.20: bytes=32 time<1ms TTL=128
Reply from 192.168.1.20: bytes=32 time<1ms TTL=128

Ping statistics for 192.168.1.20:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),`;

export const PING_FAILURE = `PC> ping 10.0.0.5

Pinging 10.0.0.5 with 32 bytes of data:

Request timed out.
Request timed out.
Request timed out.
Request timed out.

Ping statistics for 10.0.0.5:
    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`;
