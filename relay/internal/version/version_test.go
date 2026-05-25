package version

import "testing"

func TestVersionNotEmpty(t *testing.T) {
	if Version == "" {
		t.Fatal("version must not be empty")
	}
}
