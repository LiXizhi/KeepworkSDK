import YMLParser from '../src/store/YMLParser.ts';
const Y = YMLParser;

// Test backward compat: old format with content as YAML key (useFrontMatter=false)
const oldFormat = `_metadata:\n  version: 1\ncontent: "hello world"\nscore: 42`;
console.log('Old format parse (fm=false):', JSON.stringify(Y.yamlToObject(oldFormat)));
console.log('Old format parse (fm=true):', JSON.stringify(Y.yamlToObject(oldFormat, true)));

// Test: useFrontMatter=false should NOT use front-matter even with content key
const objNoFm = {_metadata:{version:1}, content:'hello'};
const yNoFm = Y.objectToYaml(objNoFm, true, false);
console.log('fm=false has no ---:', !yNoFm.includes('---') ? 'PASS' : 'FAIL');

// Test empty content (fm=true)
const emptyYaml = Y.objectToYaml({_metadata:{version:1}, content:''}, true, true);
console.log('Empty content yaml:', JSON.stringify(emptyYaml));
console.log('Empty content parse:', JSON.stringify(Y.yamlToObject(emptyYaml, true)));

// Test content with --- inside (fm=true)
const obj3 = {_metadata:{version:2}, content:'line1\n---\nline2'};
const y3 = Y.objectToYaml(obj3, true, true);
const p3 = Y.yamlToObject(y3, true);
console.log('Content with --- roundtrip:', p3.content === obj3.content ? 'PASS' : 'FAIL');

// Test no content key (backward compat)
const obj1 = {_metadata:{version:1}, score: 100};
const y1 = Y.objectToYaml(obj1, true, true);
console.log('No content key has ---:', y1.includes('---') ? 'FAIL' : 'PASS');
console.log('No content roundtrip:', JSON.stringify(Y.yamlToObject(y1)));

// Test multiline content roundtrip (fm=true)
const bigContent = 'function hello() {\n  console.log("hi");\n}\n\nhello();';
const obj4 = {_metadata:{version:3}, tag: 'js', content: bigContent};
const y4 = Y.objectToYaml(obj4, true, true);
const p4 = Y.yamlToObject(y4, true);
console.log('Multiline roundtrip:', p4.content === bigContent ? 'PASS' : 'FAIL');
console.log('Tag preserved:', p4.tag === 'js' ? 'PASS' : 'FAIL');

console.log('\nAll tests done.');
