export function uint32ToIpv4(address: number): string {
    if (address < 0 || address > 0xFFFFFFFF) {
        throw new Error("Invalid IPv4 uint32 address");
    }
    return [
        (address >> 24) & 0xFF,
        (address >> 16) & 0xFF,
        (address >> 8) & 0xFF,
        address & 0xFF,
    ].join(".");
}