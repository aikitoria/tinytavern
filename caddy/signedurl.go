// Package signedurl provides only signed-URL verification. Routes belong in the Caddyfile.
package signedurl

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

func init() {
	caddy.RegisterModule(SignedURL{})
}

type SignedURL struct {
	KeyFile string `json:"key_file"`
	key     []byte
}

func (SignedURL) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.matchers.tinytavern_signed_url",
		New: func() caddy.Module { return new(SignedURL) },
	}
}

func (s *SignedURL) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	for d.Next() {
		if !d.AllArgs(&s.KeyFile) {
			return d.ArgErr()
		}
		if d.NextBlock(0) {
			return d.Err("no subdirectives supported")
		}
	}
	return nil
}

func (s *SignedURL) Provision(caddy.Context) error {
	data, err := os.ReadFile(s.KeyFile)
	if err != nil {
		return err
	}
	s.key, err = hex.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(s.key) != 32 {
		return fmt.Errorf("signing key must contain 32 hex-encoded bytes")
	}
	return nil
}

// The signer appends &expires=<unix seconds>&sig=<base64url HMAC> to the URI.
// Sign the exact bytes before &sig=, including the expiry and any existing query.
func (s *SignedURL) valid(uri string, now int64) bool {
	signed, signature, ok := strings.Cut(uri, "&sig=")
	if !ok {
		return false
	}
	expiryIndex := strings.LastIndex(signed, "expires=")
	if expiryIndex < 1 || (signed[expiryIndex-1] != '?' && signed[expiryIndex-1] != '&') {
		return false
	}
	expiry, err := strconv.ParseInt(signed[expiryIndex+8:], 10, 64)
	if err != nil || expiry <= now {
		return false
	}
	supplied, err := base64.RawURLEncoding.Strict().DecodeString(signature)
	if err != nil || len(supplied) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(signed))
	return hmac.Equal(supplied, mac.Sum(nil))
}

func (s *SignedURL) Match(r *http.Request) bool {
	return s.valid(r.RequestURI, time.Now().Unix())
}

var _ caddy.Provisioner = (*SignedURL)(nil)
var _ caddyfile.Unmarshaler = (*SignedURL)(nil)
var _ caddyhttp.RequestMatcher = (*SignedURL)(nil)
