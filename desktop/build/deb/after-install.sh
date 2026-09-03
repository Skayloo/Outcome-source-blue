#!/bin/bash
# Replaces electron-builder's generated post-install script. The first half is its logic kept
# verbatim; the second half is why this file exists at all.
set -e

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/outcome-desktop' -a -e '/usr/bin/outcome-desktop' -a "`readlink '/usr/bin/outcome-desktop'`" != '/etc/alternatives/outcome-desktop' ]; then
        rm -f '/usr/bin/outcome-desktop'
    fi
    update-alternatives --install '/usr/bin/outcome-desktop' 'outcome-desktop' '/opt/Outcome/outcome-desktop' 100 || ln -sf '/opt/Outcome/outcome-desktop' '/usr/bin/outcome-desktop'
else
    ln -sf '/opt/Outcome/outcome-desktop' '/usr/bin/outcome-desktop'
fi

# THE SANDBOX.
#
# electron-builder's own script decides this by running `unshare --user` AS ROOT at install
# time. Root is never subject to the restriction, so on Ubuntu 24.04+ the test succeeds, the
# script concludes namespaces work, and it REMOVES the setuid bit. The app then starts as an
# ordinary user, finds neither mechanism available, and aborts:
#
#   FATAL:setuid_sandbox_host.cc  The SUID sandbox helper binary was found, but is not
#   configured correctly. Rather than run without sandboxing I'm aborting now.
#
# which the desktop reports as a crash with SIGTRAP. Installing succeeds; the app never opens.
#
# Preferred fix is the AppArmor profile: the namespace sandbox keeps working and nothing runs
# setuid root. The setuid helper stays as the fallback for systems with no AppArmor 4 to load
# that profile into — those are also the systems where unprivileged namespaces are unrestricted
# or absent, which is exactly when the helper is the right mechanism.
profile_loaded=0
if command -v apparmor_parser >/dev/null 2>&1 && [ -f /etc/apparmor.d/outcome-desktop ]; then
    apparmor_parser -r -T -W /etc/apparmor.d/outcome-desktop >/dev/null 2>&1 && profile_loaded=1
fi

if [ "$profile_loaded" -eq 1 ]; then
    chmod 0755 '/opt/Outcome/chrome-sandbox' || true
else
    chmod 4755 '/opt/Outcome/chrome-sandbox' || true
fi
