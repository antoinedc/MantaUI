import Foundation

// Split out of ChatModels.swift so these Foundation-only JSON accessors can
// compile on Linux (the rest of ChatModels.swift needs SwiftUI/Combine types
// and stays out of the SwiftPM package).

// MARK: - JSON accessors (read-only safe helpers over JSONValue)

enum ChatJSON {
    static func string(_ v: JSONValue?) -> String? {
        if case .string(let s)? = v { return s }
        return nil
    }
    static func number(_ v: JSONValue?) -> Double? {
        if case .number(let n)? = v { return n }
        return nil
    }
    static func object(_ v: JSONValue?) -> [String: JSONValue]? {
        if case .object(let o)? = v { return o }
        return nil
    }
    static func array(_ v: JSONValue?) -> [JSONValue]? {
        if case .array(let a)? = v { return a }
        return nil
    }
}
