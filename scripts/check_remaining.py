import re
css = open('src/styles.css').read()
rem = re.findall(r'#(?:[0-9a-fA-F]{3}){1,2}', css)
uniq = sorted(set(rem))
print(f"Remaining: {len(uniq)}")
for v in uniq:
    print(v)
