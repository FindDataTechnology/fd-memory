# Undefined-global check for engine.py (2026-11-11).
#
# Why: the retry loop shipped in 5e915c5 crashed with
# `NameError: name 'asyncio' is not defined` the first time a retry actually
# fired — the happy path never reaches that line, so unit tests on the pure
# policy functions could not see it. engine.py cannot be imported in tests (it
# pulls openai + hy-memory at module level), so this reads the source via
# `symtable` instead and asserts every global a function references exists at
# module level (or is a builtin).
import builtins
import os
import symtable
import unittest

ENGINE = os.path.join(os.path.dirname(__file__), "..", "engine.py")


def _module_defined(table):
    names = set()
    for sym in table.get_symbols():
        # Imported modules, assignments, defs and classes all land here as
        # defined symbols; parameters/locals of nested scopes never do.
        if sym.is_assigned() or sym.is_imported() or sym.is_namespace():
            names.add(sym.get_name())
    return names


def _walk(table):
    yield table
    for child in table.get_children():
        yield from _walk(child)


class TestEngineGlobals(unittest.TestCase):
    def test_no_function_references_an_undefined_global(self):
        with open(ENGINE) as f:
            src = f.read()
        top = symtable.symtable(src, "engine.py", "exec")
        defined = _module_defined(top) | set(dir(builtins))
        missing = []
        for table in _walk(top):
            if table.get_type() == "module":
                continue
            for sym in table.get_symbols():
                if not sym.is_global() or not sym.is_referenced():
                    continue
                name = sym.get_name()
                if name not in defined:
                    missing.append(f"{table.get_name()}(): {name}")
        self.assertEqual(missing, [], "undefined globals in engine.py: " + ", ".join(missing))


if __name__ == "__main__":
    unittest.main()
